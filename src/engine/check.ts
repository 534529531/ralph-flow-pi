/**
 * Adversarial Check (Independent Verification) — Pi adapter.
 *
 * Mirrors the contract of both plugin versions' adversarialCheck: same inputs,
 * same `{ passed, infra?, reason }` result, same infra-vs-work-failure
 * classification (an infra result pauses with check_error and does NOT burn a
 * failure count, so `ralphflow_continue` re-verifies for free).
 *
 * The execution vehicle is what differs. The Claude version spawned
 * `claude -p --allowedTools "…"`; the opencode version opened an SDK session
 * with the read-only `ralph-check` agent. Here the verifier is a fresh Pi
 * session that is read-only *structurally*: it gets Pi's read-only built-ins
 * (read/grep/find/ls — no bash, no edit, no write) plus exactly two custom
 * tools, `check_bash` (whitelist-enforced) and `verdict`. There is no host
 * permission layer to misconfigure, and no prompt asking the model to please
 * not write.
 *
 * The verdict likewise moved from prose to a tool call: the plugins parsed
 * `<promise-check>true</promise-check>` off the last line, which meant a model
 * that reasoned past its own tag, or fenced it, silently read as "false".
 *
 * Cancellation: the check session's JSONL path is written to the instance dir
 * (.adversarial-session — counterpart of the Claude version's .adversarial-pid)
 * and an abort handle is registered in-process so destroyInstance can reach it.
 * A check owned by ANOTHER process cannot be reached from here; its result is
 * discarded by the caller's post-check state re-read.
 */

import fs from "fs";
import { Type } from "typebox";
import {
  DEFAULT_ADVERSARIAL_SYSTEM_PROMPT,
  DEFAULT_ADVERSARIAL_TIMEOUT_MS,
  truncateCheckReason,
  type Engine,
} from "./core.js";
import { checkCommand, runApprovedCommand } from "./check-bash.js";
import type { AdversarialCheckConfig, CheckResult, NormalStepDef } from "./types.js";
import {
  createCheckSession,
  defineTool,
  resolveModel,
  type SessionHandle,
  type StepEvent,
  type ToolDefinition,
} from "../pi/adapter.js";

interface ActiveCheck {
  session: SessionHandle | null;
  abort: () => void;
}

const activeChecks = new Map<string, ActiveCheck>(); // instId -> handle

/** Abort a still-running check for an instance (in-process only). */
export function abortActiveCheck(instId: string): void {
  const active = activeChecks.get(instId);
  if (!active) return;
  activeChecks.delete(instId);
  try { active.abort(); } catch {}
  // Fire-and-forget: the awaiting side resolves through its own abort flag.
  const session = active.session;
  if (session) {
    Promise.resolve()
      .then(() => session.abort())
      .catch(() => {})
      .then(() => session.dispose())
      .catch(() => {});
  }
}

export function hasActiveCheck(instId: string): boolean {
  return activeChecks.has(instId);
}

/** What the `verdict` tool captured for one check run. */
interface VerdictSlot {
  submitted: boolean;
  passed: boolean;
  reason: string;
}

function makeVerdictTool(slot: VerdictSlot): ToolDefinition {
  return defineTool({
    name: "verdict",
    label: "Verdict",
    description:
      "提交本次验证的最终结论。这是结束检查的唯一方式——只输出文字不调用本工具，等同于没有给出结论。",
    parameters: Type.Object({
      pass: Type.Boolean({ description: "检查依据中的每一项都满足时为 true；任何一项不满足为 false。" }),
      reason: Type.String({
        description:
          "结论的具体依据：引用你实际看到的文件内容、命令输出。不要只写“符合要求”。不通过时说明具体哪一项不满足。",
      }),
    }),
    execute: async (_toolCallId, params) => {
      slot.submitted = true;
      slot.passed = !!params.pass;
      slot.reason = truncateCheckReason(String(params.reason ?? ""));
      return {
        content: [{ type: "text", text: `结论已记录：${slot.passed ? "通过" : "不通过"}` }],
        details: {},
      };
    },
  }) as unknown as ToolDefinition;
}

interface CheckBashToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { denied: boolean; exitCode: number | null; timedOut: boolean };
}

/**
 * The verifier's shell. Every command is whitelist-checked before it can spawn
 * (see check-bash.ts) — a denial returns a normal tool result explaining why, so
 * the model can pick a read-only alternative instead of derailing the check.
 */
function makeCheckBashTool(cwd: string, onEvent: (line: string) => void, extraAllowedBash?: string[]): ToolDefinition {
  const extraNote = extraAllowedBash && extraAllowedBash.length > 0
    ? ` 本工作流额外允许：${extraAllowedBash.join("、")}。`
    : "";
  return defineTool({
    name: "check_bash",
    label: "Bash (只读)",
    description:
      "运行只读的 shell 命令来验证工作（如 cat/grep/ls/git diff/cargo test/npm test/pytest）。" +
      "任何会修改工作区的命令都会被拒绝：你只能审查，不能修改。" + extraNote,
    parameters: Type.Object({
      command: Type.String({ description: "要执行的 shell 命令（只读）" }),
    }),
    execute: async (_toolCallId, params, signal): Promise<CheckBashToolResult> => {
      const command = String(params.command ?? "");
      const decision = checkCommand(command, extraAllowedBash);
      if (!decision.allowed) {
        const detail = decision.offendingSegment ? `（问题片段：\`${decision.offendingSegment}\`）` : "";
        onEvent(`denied: ${command}`);
        // Returned as a normal result, not thrown: the model should read WHY and
        // pick a read-only alternative, not treat the check itself as broken.
        return {
          content: [{
            type: "text",
            text: `命令被拒绝${detail}：${decision.reason}\n\n你是只读验证者，只能运行不修改工作区的命令。请改用只读方式验证。`,
          }],
          details: { denied: true, exitCode: null, timedOut: false },
        };
      }
      onEvent(`run: ${command}`);
      const result = await runApprovedCommand(command, cwd, signal);
      const status = result.exitCode === 0 ? "" : `\n(exit code: ${result.exitCode})`;
      return {
        content: [{ type: "text", text: (result.output || "(无输出)") + status }],
        details: { denied: false, exitCode: result.exitCode, timedOut: result.timedOut },
      };
    },
  }) as unknown as ToolDefinition;
}

/** Seam for tests: swap in a scripted session instead of a real model call. */
export type CheckSessionFactory = typeof createCheckSession;

export interface AdversarialCheckDeps {
  createSession?: CheckSessionFactory;
}

/**
 * Run the independent verification for a step. `checkPrompt` is built by the
 * caller (with the explicit instId) and passed in, so this function needs no
 * instance binding of its own.
 */
export async function adversarialCheck(
  engine: Engine,
  instId: string,
  step: NormalStepDef,
  checkPrompt: string,
  userTask: string | undefined,
  adversarialConfig?: AdversarialCheckConfig,
  onBashEvent?: (line: string) => void,
  deps?: AdversarialCheckDeps,
  /** Live stream of the verifier session (reasoning / text / tool calls) for the run view. */
  onEvent?: (event: StepEvent) => void
): Promise<CheckResult> {
  const createSession = deps?.createSession ?? createCheckSession;
  const systemPrompt = adversarialConfig?.system_prompt || DEFAULT_ADVERSARIAL_SYSTEM_PROMPT;
  const timeout = adversarialConfig?.timeout_ms || DEFAULT_ADVERSARIAL_TIMEOUT_MS;

  if (!engine.instanceExists(instId)) {
    return { passed: false, reason: "工作流实例已被取消。" };
  }
  // Re-validate extra_dirs here, not just at start: a dir deleted mid-workflow
  // would otherwise surface as a cryptic failure. Infra error → check_error
  // pause, no fail burn; continue re-verifies once the dir is restored.
  const extraDirs = engine.readExtraDirs(instId);
  const missingDirs = extraDirs.filter((d) => {
    try { return !fs.statSync(d).isDirectory(); } catch { return true; }
  });
  if (missingDirs.length > 0) {
    return { passed: false, infra: true, reason: `启动时通过 extra_dirs 声明的目录已不存在：${missingDirs.map((d) => `\`${d}\``).join("、")}。恢复该目录（或重新启动工作流）后调用 ralphflow_continue 重新验证。` };
  }

  // Resolve the verifier model. An unresolvable spec is a warning, not a
  // failure: fall back to the default model, same as both plugin versions.
  let model: unknown;
  let modelLabel = "default";
  if (adversarialConfig?.model) {
    const resolved = await resolveModel(adversarialConfig.model);
    if (resolved.error || !resolved.model) {
      engine.logEvent(instId, "warn", "adversarial_check_model_unresolved", { stepId: step.id, model: adversarialConfig.model, error: resolved.error });
    } else {
      model = resolved.model;
      modelLabel = adversarialConfig.model;
    }
  }

  engine.logEvent(instId, "info", "adversarial_check_start", { stepId: step.id, model: modelLabel, timeout_ms: timeout, extra_dirs: extraDirs });

  // Log the (near-)full prompts sent to the verifier, so the execution log is a
  // faithful record of exactly what was checked. Truncated to bound the line.
  const truncate = (t: string) => (t.length > 3000 ? t.substring(0, 3000) + "…(截断)" : t);
  engine.logEvent(instId, "info", "adversarial_check_prompt", { stepId: step.id, systemPrompt: truncate(systemPrompt), checkPrompt: truncate(checkPrompt) });

  const slot: VerdictSlot = { submitted: false, passed: false, reason: "" };
  let aborted = false;
  const handle: ActiveCheck = { session: null, abort: () => { aborted = true; } };
  activeChecks.set(instId, handle);

  let session: SessionHandle;
  try {
    session = await createSession({
      cwd: engine.projectDir,
      model,
      systemPrompt,
      customTools: [
        makeCheckBashTool(engine.projectDir, (line) => onBashEvent?.(line), adversarialConfig?.extra_allowed_bash),
        makeVerdictTool(slot),
      ],
      // The check transcript is disposable — the verdict and its reason are what
      // survive, in state.last_failure_reason and the final report.
      disableCompaction: true,
    });
    handle.session = session;
    // Forward the verifier's live stream (reasoning, bash commands, verdict tool)
    // so the run view shows CHECK as a first-class visible phase, not a black box.
    if (onEvent) session.subscribe(onEvent);
  } catch (err: any) {
    activeChecks.delete(instId);
    engine.logEvent(instId, "error", "adversarial_check_session_create_failed", { stepId: step.id, error: err.message });
    return { passed: false, infra: true, reason: `验证会话创建失败：${err.message}` };
  }

  // Close the cancel race: a cross-process cancel between the pre-check above
  // and the registration here finds nothing to abort and deletes the instance
  // dir. If the instance is gone now, nobody else can reach this session —
  // clean it up ourselves.
  if (!engine.instanceExists(instId)) {
    activeChecks.delete(instId);
    session.dispose();
    engine.logEvent(instId, "warn", "adversarial_check_cancelled_before_start", { stepId: step.id });
    return { passed: false, reason: "工作流实例已被取消。" };
  }
  if (session.jsonlPath) engine.writeAdversarialSession(session.jsonlPath, instId);

  const startTime = Date.now();
  // Liveness watchdog: one log line a minute, so a stuck check is visible in the
  // execution log rather than looking like a hang.
  const keepalive = setInterval(() => {
    engine.logEvent(instId, "info", "adversarial_check_keepalive", { stepId: step.id, elapsed_ms: Date.now() - startTime });
  }, 60_000);

  try {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error("Adversarial check timeout")), timeout);
    });

    try {
      const run = session.prompt(checkPrompt);
      // If the timeout wins the race, this promise stays pending and may reject
      // later (most reliably right after abort()). An unhandled late rejection
      // would take the process down, so neutralize it here; the race below still
      // decides the outcome.
      Promise.resolve(run).catch(() => {});
      await Promise.race([run, deadline]);

      // No verdict yet? Ask once. A check that reasoned to a conclusion but
      // forgot the tool call is the common case, and re-prompting is far cheaper
      // than an infra pause. (The plugins had no equivalent: a missing tag just
      // read as "false" — a silent wrong verdict.)
      if (!slot.submitted && !aborted && engine.instanceExists(instId)) {
        engine.logEvent(instId, "info", "adversarial_check_verdict_missing_retry", { stepId: step.id });
        const retry = session.followUp("你还没有提交结论。请立即调用 `verdict` 工具，给出 pass 与具体的 reason。");
        Promise.resolve(retry).catch(() => {});
        await Promise.race([retry, deadline]);
      }
    } catch (err: any) {
      if (aborted || !engine.instanceExists(instId)) {
        return { passed: false, infra: true, reason: "工作流实例已被取消。" };
      }
      if (String(err.message).includes("timeout")) {
        // Abort the runaway generation before reporting.
        await session.abort();
        engine.logEvent(instId, "warn", "adversarial_check_timeout", { stepId: step.id });
        return {
          passed: false,
          infra: true,
          reason: `检查阶段超时（${Math.round(timeout / 60000)} 分钟）。验证耗时过长。

可能原因：
- 验证会话响应缓慢或无响应
- 任务对于验证模型过于复杂
- API 端点未响应

建议：
1. 使用 /ralphflow-status 查看当前状态
2. 使用 /ralphflow-continue 重试
3. 或使用 /ralphflow-cancel 取消工作流
4. 如果任务确实需要更长时间，可以在工作流配置中增加 timeout_ms`,
        };
      }
      engine.logEvent(instId, "error", "adversarial_check_error", { stepId: step.id, error: err.message });
      return { passed: false, infra: true, reason: `验证会话执行失败：${err.message}` };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    if (aborted) {
      return { passed: false, infra: true, reason: "工作流实例已被取消。" };
    }

    if (!slot.submitted) {
      // Still nothing after the nudge. This is an infra failure, NOT a work
      // failure: we have no verdict, so we must not burn the step's fail count.
      engine.logEvent(instId, "warn", "adversarial_check_no_verdict", { stepId: step.id });
      return { passed: false, infra: true, reason: "验证者没有提交结论（未调用 verdict 工具）。调用 ralphflow_continue 可重新验证。" };
    }

    const reason = slot.reason || (slot.passed ? "检查通过。" : "检查失败（验证者未说明原因）。");
    // One clear line per check (verdict + a short reason snippet). The full
    // reason lives in state.last_failure_reason and the final report.
    engine.logEvent(instId, "info", "adversarial_check_result", { stepId: step.id, passed: slot.passed, len: reason.length, reason: reason.substring(0, 160) });
    return { passed: slot.passed, reason };
  } finally {
    clearInterval(keepalive);
    if (activeChecks.get(instId) === handle) activeChecks.delete(instId);
    if (session.jsonlPath && engine.readAdversarialSession(instId) === session.jsonlPath) {
      engine.clearAdversarialSession(instId);
    }
    session.dispose();
  }
}
