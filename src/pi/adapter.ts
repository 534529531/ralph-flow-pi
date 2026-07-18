/**
 * Anti-corruption layer over the Pi SDK.
 *
 * This is the ONLY file in the package allowed to import @earendil-works/*.
 * Pi is on 0.x with a fast release cadence (244 releases by v0.80.7), so the
 * blast radius of an API change has to stay inside these ~250 lines: everything
 * else talks to the narrow interfaces below and to our own normalized event
 * type, never to Pi's.
 *
 * Upgrade drill: bump the pinned version → fix this file → run the adapter
 * contract tests → run the CHECK smoke (`ralph _check-once`).
 */

import fs from "fs";
import path from "path";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  getAgentDir,
  parseSessionEntries,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  CURRENT_SESSION_VERSION,
  loadSkillsFromDir,
  VERSION as PI_VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export { defineTool, loadSkillsFromDir, CURRENT_SESSION_VERSION, type Skill, type ToolDefinition };

/** Pi's read-only built-in tool set. Deliberately excludes bash: the verifier's
 *  only shell access is our whitelisted check_bash custom tool. This matches the
 *  Claude version's `--allowedTools "Read(*) Glob(*) Grep(*) …"` allow-list. */
export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/** Full coding tool set for DO steps. */
export const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

// ─── Normalized events ────────────────────────────────────────────────────────
//
// Our own shape, so a rename inside Pi's AgentSessionEvent union does not ripple
// into the runner or the TUI.

export type StepEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; text: string }
  | { type: "turn_end" }
  | { type: "agent_end" }
  | { type: "compaction_end" }
  | { type: "error"; message: string };

export type StepEventListener = (event: StepEvent) => void;

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

/** Translate one Pi event into zero or one of ours. */
function normalize(event: AgentSessionEvent): StepEvent | null {
  const e = event as any;
  switch (e.type) {
    case "message_update": {
      const inner = e.assistantMessageEvent;
      if (!inner) return null;
      if (inner.type === "text_delta" && typeof inner.delta === "string") return { type: "text", delta: inner.delta };
      if (inner.type === "thinking_delta" && typeof inner.delta === "string") return { type: "reasoning", delta: inner.delta };
      return null;
    }
    case "tool_execution_start":
      return { type: "tool_start", toolCallId: String(e.toolCallId ?? ""), toolName: String(e.toolName ?? ""), args: e.args };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: String(e.toolCallId ?? ""),
        toolName: String(e.toolName ?? ""),
        isError: !!e.isError,
        text: textOf(e.result?.content),
      };
    case "turn_end":
      return { type: "turn_end" };
    case "agent_end":
      // willRetry means Pi is auto-retrying a provider error — the turn is not
      // actually over, so don't wake the runner's keep-alive on it.
      return e.willRetry ? null : { type: "agent_end" };
    case "compaction_end":
      return e.aborted ? null : { type: "compaction_end" };
    default:
      return null;
  }
}

// ─── Session handle ───────────────────────────────────────────────────────────

export interface SessionHandle {
  /** Send a prompt and resolve when the agent settles (turn complete). */
  prompt(text: string): Promise<void>;
  /** Queue a message for the next turn. */
  followUp(text: string): Promise<void>;
  /** Redirect the turn currently streaming. */
  steer(text: string): Promise<void>;
  /** Subscribe to normalized events; returns an unsubscribe function. */
  subscribe(listener: StepEventListener): () => void;
  /** Abort whatever is in flight. */
  abort(): Promise<void>;
  /** Release resources. Safe to call twice. */
  dispose(): void;
  /** Absolute path of this session's JSONL, when persisted. */
  readonly jsonlPath: string | null;
}

function wrap(session: AgentSession, jsonlPath: string | null): SessionHandle {
  let disposed = false;
  return {
    jsonlPath,
    async prompt(text: string) {
      await session.prompt(text);
    },
    async followUp(text: string) {
      await session.followUp(text);
    },
    async steer(text: string) {
      await session.steer(text);
    },
    subscribe(listener: StepEventListener) {
      return session.subscribe((event: AgentSessionEvent) => {
        const normalized = normalize(event);
        if (normalized) listener(normalized);
      });
    },
    async abort() {
      try { await session.abort(); } catch {}
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { session.dispose(); } catch {}
    },
  };
}

// ─── Model resolution ─────────────────────────────────────────────────────────

export interface ResolvedModel {
  /** Opaque to callers — only ever handed back to createStepSession/createCheckSession. */
  model: unknown;
  thinkingLevel?: string;
  warning?: string;
  error?: string;
}

let sharedRuntime: ModelRuntime | null = null;

async function getRuntime(): Promise<ModelRuntime> {
  if (!sharedRuntime) {
    sharedRuntime = await ModelRuntime.create();
  }
  return sharedRuntime;
}

/**
 * Resolve a "provider/model" or "provider/model:thinking" string.
 *
 * This is where adversarial_check.model gets its cross-provider superpower for
 * free: pi-ai resolves any provider, so a workflow can verify Claude's work with
 * GPT without the engine knowing anything about either.
 *
 * Returns `{ error }` rather than throwing — callers fall back to the session's
 * default model, matching the plugin versions' "unresolvable model falls back"
 * behavior.
 */
export async function resolveModel(spec: string): Promise<ResolvedModel> {
  const trimmed = String(spec || "").trim();
  if (!trimmed) return { model: undefined, error: "empty model spec" };
  try {
    const modelRuntime = await getRuntime();
    const result = resolveCliModel({ cliModel: trimmed, modelRuntime });
    return {
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      warning: result.warning ?? undefined,
      error: result.error ?? undefined,
    };
  } catch (e: any) {
    return { model: undefined, error: e?.message || String(e) };
  }
}

// ─── Session creation ─────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  cwd: string;
  /** Resolved model, or undefined to use Pi's configured default. */
  model?: unknown;
  thinkingLevel?: string;
  /** Built-in tool allowlist. */
  tools: readonly string[];
  customTools?: ToolDefinition[];
  /** Replaces the whole system prompt when set. */
  systemPrompt?: string;
  /** Appended to the default system prompt when set (used for the skill catalog). */
  appendSystemPrompt?: string;
  /**
   * Persist the transcript into this directory, one session per directory.
   *
   * Pi derives its own filename (`<timestamp>_<id>.jsonl`) and gives no way to
   * dictate it, so the unit we control is the directory: the runner passes one
   * dir per step attempt. A dir that already holds a .jsonl is RESUMED — that is
   * what lets a check-failed retry continue the same step session, and a crashed
   * run pick its step session back up. Omit for an unpersisted session.
   */
  sessionDir?: string;
  /** Disable auto-compaction (steps are short; determinism beats headroom). */
  disableCompaction?: boolean;
  /** Don't load the user's pi extensions into this session. */
  noExtensions?: boolean;
  /**
   * Absolute SKILL.md paths to offer this session. Pi appends a catalog (name,
   * description, absolute location) to the system prompt and the model loads a
   * skill with the `read` tool — no custom tool involved.
   */
  skillPaths?: string[];
  /** Load no skills at all, not even the user's own. */
  noSkills?: boolean;
}

/** The existing transcript in a session dir, if any. */
export function findSessionFile(sessionDir: string): string | null {
  try {
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
    // Newest wins if a dir somehow holds several (Pi's names sort chronologically).
    return files.length > 0 ? path.join(sessionDir, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

async function build(options: CreateSessionOptions): Promise<SessionHandle> {
  const {
    cwd, model, thinkingLevel, tools, customTools,
    systemPrompt, appendSystemPrompt, sessionDir, disableCompaction, noExtensions,
    skillPaths, noSkills,
  } = options;

  // Pi's `tools` option is an allowlist over ALL tools, custom ones included
  // (sdk.js: `initialActiveToolNames = options.tools ? [...options.tools] : …`).
  // Registering a custom tool without naming it here leaves it inactive — which
  // for the check session would mean a verifier that can never submit a verdict,
  // and would look like a permanent infra failure rather than a wiring bug.
  const activeTools = [...tools, ...(customTools ?? []).map((t) => t.name)];

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // The verifier must not inherit the user's pi extensions: an extension can
    // register arbitrary tools, and a write tool smuggled into the check session
    // would break the read-only guarantee this whole design rests on.
    ...(noExtensions ? { noExtensions: true } : {}),
    ...(noSkills ? { noSkills: true } : {}),
    ...(skillPaths && skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
    ...(systemPrompt !== undefined ? { systemPromptOverride: () => systemPrompt } : {}),
    ...(appendSystemPrompt !== undefined
      ? { appendSystemPromptOverride: (base: string[]) => [...base, appendSystemPrompt] }
      : {}),
  });
  await resourceLoader.reload();

  let sessionManager: SessionManager;
  if (sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true });
    const existing = findSessionFile(sessionDir);
    sessionManager = existing
      ? SessionManager.open(existing, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir);
  } else {
    sessionManager = SessionManager.inMemory(cwd);
  }

  const settingsManager = disableCompaction
    ? SettingsManager.inMemory({ compaction: { enabled: false } } as any)
    : undefined;

  const { session } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    ...(model ? { model: model as any } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as any } : {}),
    tools: activeTools,
    ...(customTools ? { customTools } : {}),
    resourceLoader,
    sessionManager,
    ...(settingsManager ? { settingsManager } : {}),
  });

  // Resolved only after creation: Pi names the file lazily.
  const resolvedPath = (() => {
    try { return sessionManager.getSessionFile() ?? null; } catch { return null; }
  })();

  return wrap(session, resolvedPath);
}

/** A DO step session: full coding tools, persisted, fresh context per step. */
export async function createStepSession(options: Omit<CreateSessionOptions, "tools"> & { tools?: readonly string[] }): Promise<SessionHandle> {
  return build({ ...options, tools: options.tools ?? CODING_TOOL_NAMES });
}

/**
 * A CHECK session: read-only built-ins only.
 *
 * The read-only guarantee is structural, not prompted — `edit`/`write`/`bash`
 * are simply not in the tool set, so the verifier cannot mutate the workspace it
 * is judging even if the model decides it wants to.
 */
export async function createCheckSession(options: Omit<CreateSessionOptions, "tools" | "noExtensions" | "skillPaths" | "noSkills">): Promise<SessionHandle> {
  // noSkills: the verifier's job is to judge against the check criteria, not to
  // follow a playbook. Skills describe how to BUILD things; handing them to the
  // checker invites it to sympathize with the implementation it is grading.
  return build({ ...options, tools: READ_ONLY_TOOL_NAMES, noExtensions: true, noSkills: true });
}

// ─── Transcript replay ─────────────────────────────────────────────────────────
//
// Backfills the run view when it attaches to a step that was already in
// progress (ralphflow_watch, ralphflow_continue, a fresh process adopting a
// live instance) — see run-app.ts's buildInitialModel. The live path
// (`normalize`, above) turns Pi's streaming deltas into StepEvents as they
// arrive; this turns an already-complete persisted transcript into the SAME
// StepEvent shape so the run view's existing reducer (run-model.ts's
// applyStepEvent) can render history exactly like it renders anything else.
// Each text/thinking block becomes one event carrying the WHOLE string (not a
// stream of deltas) — "delta" here just means "everything at once".

/**
 * Deliberately skips user-role messages: they are either the (long) DO prompt
 * itself or the engine's own "continue" nudges sent via session.followUp
 * (runner.ts), neither of which the LIVE view shows either — applyUserMessage
 * (run-model.ts) is only ever called for real human input typed into the run
 * view, never wired to session.subscribe. Replaying them would show the
 * engine talking to itself as if it were the user.
 */
export function replaySessionEvents(sessionDir: string): StepEvent[] {
  const file = findSessionFile(sessionDir);
  if (!file) return [];
  let entries: any[];
  try {
    entries = parseSessionEntries(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const events: StepEvent[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "assistant") {
      for (const c of msg.content ?? []) {
        if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking) {
          events.push({ type: "reasoning", delta: c.thinking });
        } else if (c?.type === "text" && typeof c.text === "string" && c.text) {
          events.push({ type: "text", delta: c.text });
        } else if (c?.type === "toolCall") {
          events.push({ type: "tool_start", toolCallId: String(c.id ?? ""), toolName: String(c.name ?? ""), args: c.arguments });
        }
      }
    } else if (msg.role === "toolResult") {
      events.push({
        type: "tool_end",
        toolCallId: String(msg.toolCallId ?? ""),
        toolName: String(msg.toolName ?? ""),
        isError: !!msg.isError,
        text: textOf(msg.content),
      });
    }
  }
  return events;
}

/**
 * Caps how much of a replayed transcript actually reaches the view. A step's
 * history can in principle be arbitrarily long (many tool calls, long
 * reasoning), and render.ts's renderStream has no windowing — it re-wraps
 * every block on every render, including once a second while a phase is
 * active (run-app.ts's tickTimer). Sized generously (this exists to fix
 * "history is invisible", not to hide most of it) — it only guards the
 * pathological long-tail case, keeping the most recent events (the ones
 * actually relevant right after attaching) and dropping older ones.
 */
const REPLAY_MAX_EVENTS = 500;
const REPLAY_MAX_CHARS = 300_000;

function eventChars(e: StepEvent): number {
  switch (e.type) {
    case "text":
    case "reasoning":
      return e.delta.length;
    case "tool_end":
      return e.toolName.length + e.text.length;
    case "tool_start":
      return e.toolName.length + 100; // args are a small fixed-ish JSON blob
    default:
      return 0;
  }
}

/** Keeps the tail of `events`, dropping from the front once either budget is hit. */
export function truncateReplayEvents(events: StepEvent[]): { events: StepEvent[]; omitted: number } {
  let chars = 0;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    chars += eventChars(events[i]);
    if (events.length - i > REPLAY_MAX_EVENTS || chars > REPLAY_MAX_CHARS) { start = i + 1; break; }
    start = i;
  }
  return { events: events.slice(start), omitted: start };
}

/** The pinned Pi version, surfaced for diagnostics. */
export function piVersion(): string {
  return PI_VERSION;
}
