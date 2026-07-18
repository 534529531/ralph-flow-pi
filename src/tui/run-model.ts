/**
 * The run view's state, as a pure reducer over runner events.
 *
 * This is the heart of Direction A: instead of a chat transcript relayed by a
 * supervisor LLM, the run view is a deterministic projection of what the engine
 * is doing. Everything the user sees is computed here from structured events —
 * no model, no text parsing — so the whole thing is unit-testable without a
 * terminal or an API key. The pi-tui renderer (run-view.ts) is a thin function
 * of this state.
 *
 * Design choices worth stating:
 *  - The step list is the spine. It comes from the workflow definition, so the
 *    user always sees the whole pipeline and where they are in it — the thing a
 *    chat transcript could never show.
 *  - Each step keeps its OWN stream (blocks). Switching the active step swaps
 *    which stream is shown; nothing is lost, and a retry appends to the same
 *    step. This mirrors the engine's "fresh session per step" faithfully: one
 *    visible timeline per step.
 *  - Streaming deltas are coalesced into blocks (a run of reasoning, a run of
 *    text, one block per tool call) so the renderer sees stable structure, not a
 *    token firehose.
 */

import type { RalphFlowState, StepDef, WorkflowDef } from "../engine/types.js";
import { isSubWorkflowStep } from "../engine/types.js";
import type { StepEvent } from "../pi/adapter.js";

export type RunStatus =
  | "running"     // a step is executing
  | "gate"        // waiting for the user to approve a manual step
  | "paused"      // stopped, needs the user to fix + continue
  | "stalled"     // DO gave up driving; needs the user to nudge
  | "completed"   // finished
  | "cancelled";  // torn down

export type StepStatus = "pending" | "do" | "check" | "passed" | "failed" | "gate" | "done";

export interface StepView {
  id: string;
  desc: string;
  isSubWorkflow: boolean;
  status: StepStatus;
  attempts: number;
  /** The most recent verdict reason for this step, if any. */
  lastReason?: string;
}

export type StreamBlock =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; arg: string; status: "running" | "ok" | "error"; result?: string }
  | { kind: "phase"; phase: "do" | "check"; attempt: number }
  | { kind: "verdict"; passed: boolean; infra: boolean; reason: string }
  | { kind: "notice"; text: string }
  | { kind: "user"; text: string };

export interface RunModel {
  instanceId: string;
  workflowName: string;
  workflowDesc: string;
  task: string;
  steps: StepView[];
  /** Which step's stream is shown, and whether DO or CHECK is live. */
  activeStepId: string | null;
  activePhase: "do" | "check" | null;
  /**
   * When the current phase started (Date.now() epoch ms), so the status bar
   * can show elapsed time — the only way to tell "still thinking" from
   * "stuck" during a long silent stretch (no reasoning/tool events at all)
   * is a ticking clock, not the stream itself. null whenever activePhase is.
   */
  phaseStartedAt: number | null;
  status: RunStatus;
  /** Reason string for gate / pause / stall — what the user needs to know now. */
  statusDetail: string;
  reportPath?: string;
  /** Per-step live stream, keyed by step id. */
  streams: Map<string, StreamBlock[]>;
  /** Bumped on every change, so the renderer can cheaply tell "did anything happen". */
  revision: number;
}

/** Build the initial model from the workflow definition — the whole pipeline up front. */
export function initRunModel(instanceId: string, workflow: WorkflowDef, task: string): RunModel {
  const steps: StepView[] = workflow.steps.map((s: StepDef) => ({
    id: s.id,
    desc: s.desc,
    isSubWorkflow: isSubWorkflowStep(s),
    status: "pending",
    attempts: 0,
  }));
  return {
    instanceId,
    workflowName: workflow.name,
    workflowDesc: workflow.description,
    task,
    steps,
    activeStepId: null,
    activePhase: null,
    phaseStartedAt: null,
    status: "running",
    statusDetail: "",
    reportPath: undefined,
    streams: new Map(),
    revision: 0,
  };
}

function bump(m: RunModel): RunModel {
  m.revision++;
  return m;
}

function stream(m: RunModel, stepId: string): StreamBlock[] {
  let s = m.streams.get(stepId);
  if (!s) { s = []; m.streams.set(stepId, s); }
  return s;
}

function setStep(m: RunModel, stepId: string, patch: Partial<StepView>): void {
  const s = m.steps.find((x) => x.id === stepId);
  if (s) Object.assign(s, patch);
}

// ─── Event application (the reducer) ──────────────────────────────────────────
//
// Mutates in place and bumps the revision; the model is owned by one run view,
// so a fresh-object reducer would just be churn. Each function maps one runner
// event to a state change.

export function applyStepStart(m: RunModel, stepId: string, phase: "do" | "check", attempt: number): RunModel {
  m.activeStepId = stepId;
  m.activePhase = phase;
  m.phaseStartedAt = Date.now();
  m.status = "running";
  setStep(m, stepId, { status: phase, attempts: attempt });
  stream(m, stepId).push({ kind: "phase", phase, attempt });
  return bump(m);
}

export function applyStepEvent(m: RunModel, stepId: string, phase: "do" | "check", event: StepEvent): RunModel {
  const blocks = stream(m, stepId);
  const last = blocks[blocks.length - 1];
  switch (event.type) {
    case "reasoning":
      if (last && last.kind === "reasoning") last.text += event.delta;
      else blocks.push({ kind: "reasoning", text: event.delta });
      return bump(m);
    case "text":
      if (last && last.kind === "text") last.text += event.delta;
      else blocks.push({ kind: "text", text: event.delta });
      return bump(m);
    case "tool_start":
      blocks.push({ kind: "tool", name: event.toolName, arg: summarizeArg(event.args), status: "running" });
      return bump(m);
    case "tool_end": {
      const result = capText(event.text, 4000); // keep a few lines (diffs, output), bounded
      // Close the matching running tool block (most recent of that name).
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === "tool" && b.name === event.toolName && b.status === "running") {
          b.status = event.isError ? "error" : "ok";
          b.result = result;
          return bump(m);
        }
      }
      // No matching start (some tools only surface an end) — record it anyway.
      blocks.push({ kind: "tool", name: event.toolName, arg: "", status: event.isError ? "error" : "ok", result });
      return bump(m);
    }
    default:
      return m; // turn_end / agent_end / compaction — not shown
  }
}

export function applyVerdict(m: RunModel, stepId: string, result: { passed: boolean; infra?: boolean; reason: string }): RunModel {
  stream(m, stepId).push({ kind: "verdict", passed: result.passed, infra: !!result.infra, reason: result.reason });
  if (!result.infra) {
    setStep(m, stepId, { status: result.passed ? "passed" : "failed", lastReason: result.reason });
  }
  return bump(m);
}

/** A human message steered into the active DO session — the other half of the conversation. */
export function applyUserMessage(m: RunModel, stepId: string, text: string): RunModel {
  stream(m, stepId).push({ kind: "user", text });
  return bump(m);
}

/** A one-line notice injected directly into a step's stream — used to flag that
 *  a replayed transcript (see pi/adapter.ts's replaySessionEvents) was truncated. */
export function applyReplayNotice(m: RunModel, stepId: string, text: string): RunModel {
  stream(m, stepId).push({ kind: "notice", text });
  return bump(m);
}

export function applyGate(m: RunModel, stepId: string): RunModel {
  m.status = "gate";
  m.activeStepId = stepId;
  m.activePhase = null;
  m.phaseStartedAt = null;
  setStep(m, stepId, { status: "gate" });
  m.statusDetail = `步骤 “${stepLabel(m, stepId)}” 已完成，等待你的审查。`;
  stream(m, stepId).push({ kind: "notice", text: "📋 等待人工审查——通过或要求修改。" });
  return bump(m);
}

/**
 * Reconstruct a just-built model's position from persisted state, for a view
 * that's attaching to an instance instead of having launched it itself
 * (ralphflow_watch / ralphflow_continue landing back in the view / a fresh
 * process adopting a live instance at boot). Without this, `activeStepId`
 * starts null and stays null until the next runner event happens to fire —
 * which may be a long silent stretch away, or for a reattach to something
 * already past its first phase-start event, MAY NEVER FIRE AGAIN for the
 * current phase at all. `renderStream` shows nothing when `activeStepId` is
 * null (see render.ts), so the practical symptom was exactly "the view is
 * empty" — right up until, for a genuinely fresh start, the real event
 * finally arrived and fixed itself, which is why this was easy to miss in
 * testing a fresh `ralphflow_start` but reliably broke on reattach.
 *
 * Deliberately does NOT touch the stream (no phase divider, no notice) — only
 * `activeStepId`/`activePhase`/`phaseStartedAt`/step statuses. That makes it
 * safe to call unconditionally, even in the ambiguous window where a fresh
 * start's real `onStepStart` hasn't fired yet: this just pre-sets the exact
 * same values that event will also set moments later (no visible duplicate,
 * since nothing was pushed to the stream), so there's no need to distinguish
 * "genuine reattach" from "fresh start, event just hasn't arrived yet" at
 * all. `phaseStartedAt` is set to "now" as a floor, not the true start time
 * (which isn't persisted anywhere reattach can read) — an elapsed clock that
 * understates reality is still far more useful than one that's frozen or
 * absent.
 *
 * `passedStepIds`: step ids with a persisted "check passed" record (see
 * engine.loadStepRecords) — NOT inferred from position in the workflow's
 * step array, because `on_fail` can route backward and a retry loop would
 * make that guess wrong. Marked "done" so the step strip doesn't lie and
 * show already-finished work as still-pending.
 */
export function primeForAttach(m: RunModel, state: RalphFlowState, passedStepIds: string[]): RunModel {
  for (const id of passedStepIds) setStep(m, id, { status: "done" });
  if (state.current_step) {
    m.activeStepId = state.current_step;
    if (state.current_phase === "do" || state.current_phase === "check") {
      m.activePhase = state.current_phase;
      m.phaseStartedAt = Date.now();
      setStep(m, state.current_step, { status: state.current_phase, attempts: (state.fail_count || 0) + 1 });
    }
  }
  return bump(m);
}

export function applyPaused(m: RunModel, state: RalphFlowState): RunModel {
  m.status = "paused";
  m.activePhase = null;
  m.phaseStartedAt = null;
  m.statusDetail = pauseDetail(state);
  const sid = state.current_step;
  if (sid) stream(m, sid).push({ kind: "notice", text: `⏸ ${m.statusDetail}` });
  return bump(m);
}

export function applyStalled(m: RunModel, stepId: string, attempts: number): RunModel {
  m.status = "stalled";
  m.activePhase = null;
  m.phaseStartedAt = null;
  m.statusDetail = `步骤 “${stepLabel(m, stepId)}” 连续 ${attempts} 次未完成，已停止自动驱动。`;
  stream(m, stepId).push({ kind: "notice", text: `⚠️ ${m.statusDetail}` });
  return bump(m);
}

export function applyCompleted(m: RunModel, reportPath?: string): RunModel {
  m.status = "completed";
  m.activePhase = null;
  m.phaseStartedAt = null;
  m.reportPath = reportPath;
  // Any step still marked passed becomes done for the final list.
  for (const s of m.steps) if (s.status === "passed") s.status = "done";
  m.statusDetail = "工作流完成 ✓";
  return bump(m);
}

export function applyCancelled(m: RunModel): RunModel {
  m.status = "cancelled";
  m.activePhase = null;
  m.phaseStartedAt = null;
  m.statusDetail = "工作流已取消。";
  return bump(m);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function stepLabel(m: RunModel, stepId: string): string {
  return m.steps.find((s) => s.id === stepId)?.desc || stepId;
}

function pauseDetail(state: RalphFlowState): string {
  switch (state.pause_reason) {
    case "max_failures": return `已达最大失败次数：${state.last_failure_reason || "反复未通过验证"}`;
    case "config_error": return `工作流配置错误：${state.last_failure_reason || ""}`;
    case "check_error": return `验证未能运行（额度/API/超时），不计失败次数：${state.last_failure_reason || ""}`;
    case "session_aborted": return "会话中断，可恢复。";
    default: return state.last_failure_reason || `已暂停（${state.pause_reason || "未知原因"}）`;
  }
}

/** A short, single-line description of a tool call's key argument. */
export function summarizeArg(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "name"]) {
    const v = a[key];
    if (typeof v === "string" && v) return v.length > 100 ? v.slice(0, 100) + "…" : v;
  }
  return "";
}

export function firstLine(text: string): string {
  const line = String(text ?? "").trim().split("\n")[0] ?? "";
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}

/** Keep a tool result readable but bounded (diffs and command output show; huge dumps don't). */
export function capText(text: string, maxChars: number): string {
  const t = String(text ?? "").trim();
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…（已截断）" : t;
}

/**
 * Overall progress as (completed, total) for the header/status bar.
 *
 * A step earns "completed" the moment its own CHECK passes — status
 * "passed". It's promoted to "done" only in applyCompleted, when the whole
 * *workflow* finishes (a step strip icon convention, so the final screen's
 * step list reads as uniformly "done" rather than a mix of "passed"/"done").
 * That promotion happens once, at the very end — so counting only "done"
 * here made this always read 0/N for the entire run, only jumping to N/N at
 * the last moment. Both statuses mean the same thing from progress's point
 * of view: this step is behind you.
 */
export function progress(m: RunModel): { done: number; total: number } {
  const total = m.steps.filter((s) => !s.isSubWorkflow).length || m.steps.length;
  const done = m.steps.filter((s) => s.status === "done" || s.status === "passed").length;
  return { done, total };
}

/** Is the run waiting on the user right now? */
export function needsUser(m: RunModel): boolean {
  return m.status === "gate" || m.status === "paused" || m.status === "stalled";
}

export function isTerminal(m: RunModel): boolean {
  return m.status === "completed" || m.status === "cancelled";
}
