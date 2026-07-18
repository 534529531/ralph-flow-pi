/**
 * The instance runner — one loop per active workflow instance.
 *
 * This file replaces driver.ts, and it is the place where ralph-flow-pi stops
 * being a port and becomes a different thing. The opencode plugin could not own
 * the DO session: it lived in the user's chat, so the plugin waited for a
 * `session.idle` event, scraped the last assistant message, regex'd it for
 * `<promise>done</promise>`, and poked the session with `promptAsync`. Every one
 * of those steps was a guess about someone else's session.
 *
 * Here the engine creates the session, so the loop just awaits it:
 *
 *     while (instance is live and unpaused):
 *        DO      → fresh session per step, keep-alive until report_done
 *        gate    → stop and let the user review (manual steps only)
 *        CHECK   → fresh read-only session, verdict tool
 *        route   → handleCheckPassed/Failed (verbatim engine logic)
 *
 * What the DO session gets is the point of the whole project: a brand-new
 * context per step. Steps hand off through artifacts + the input/output fields,
 * never through accumulated chat history — so step 7 cannot be poisoned by the
 * debris of steps 1-6. The one exception is a check-failed retry of the SAME
 * step, which resumes the same session because "here's what you just tried and
 * why it failed" is exactly the context a fix needs, and max_fail_count bounds
 * how far it can grow.
 *
 * Behaviors carried over verbatim from driver.ts (each was load-bearing):
 *  - keep-alive budget MAX_DO_REINJECT=5, keyed per step:phase, NOT burned while
 *    the model is making tool calls (it's working, not stuck); on exhaustion the
 *    loop stops driving and hands control to the user WITHOUT pausing the state.
 *  - the manual review gate sits BEFORE the check, not after.
 *  - a check verdict is DISCARDED if the state moved while the check ran.
 *  - infra failures pause with check_error and never burn a fail count.
 */

import fs from "fs";
import path from "path";
import type { Engine } from "./core.js";
import { MANUAL_GATE_MARKER, MANUAL_STEP_MARKER } from "./core.js";
import { adversarialCheck, type AdversarialCheckDeps } from "./check.js";
import { isSubWorkflowStep, type NormalStepDef, type RalphFlowState, type StepDef, type WorkflowDef } from "./types.js";
import { createStepSession, type SessionHandle, type StepEvent, type ToolDefinition } from "../pi/adapter.js";
import { makeReportDoneTool } from "./step-tools.js";

/** Keep-alive nudges before the loop gives up and hands control to the user. */
export const MAX_DO_REINJECT = 5;

/**
 * Everything the front end needs to see. The runner never renders.
 *
 * Two kinds of events:
 *  - STRUCTURED (onStepStart / onVerdict / onGate / onPaused / onStalled /
 *    onCompleted): the run view is built from these — a clean state machine, no
 *    parsing of formatted text. This is what makes the dedicated run TUI possible.
 *  - onStepEvent: the live token stream (reasoning / text / tool calls) of the
 *    currently active session, DO or CHECK.
 *  - onMessage: pre-formatted markdown blocks (phase banners, transitions with
 *    the next DO prompt). Kept for the chat surface; the run view ignores it and
 *    uses the structured events instead.
 */
export interface RunnerEvents {
  /** A step phase began. `attempt` counts retries of the same step (1-based). */
  onStepStart?(instId: string, stepId: string, phase: "do" | "check", attempt: number): void;
  /** Live output of the active session (DO or CHECK). */
  onStepEvent?(instId: string, stepId: string, phase: "do" | "check", event: StepEvent): void;
  /** The independent verifier returned a verdict for a step. */
  onVerdict?(instId: string, stepId: string, result: { passed: boolean; infra?: boolean; reason: string }): void;
  /** A block of engine-authored markdown (phase banners, transitions). Chat surface only. */
  onMessage?(instId: string, text: string): void;
  /** The DO phase of a manual step finished; the user must review. */
  onGate?(instId: string, stepId: string): void;
  /** The instance paused (max_failures / config_error / check_error / session_aborted). */
  onPaused?(instId: string, state: RalphFlowState): void;
  /** The keep-alive budget ran out — not paused, just no longer driven. */
  onStalled?(instId: string, stepId: string, attempts: number): void;
  /** The workflow finished; the instance is gone. */
  onCompleted?(instId: string, reportPath?: string): void;
}

export interface RunnerDeps {
  /** Model for DO sessions — the TUI's current model, read fresh each step. */
  currentModel?(): { model?: unknown; thinkingLevel?: string };
  /** Extra tools for DO sessions, beyond report_done. */
  stepTools?(instId: string): ToolDefinition[];
  /**
   * Absolute SKILL.md paths offered to DO sessions. Pi puts the catalog in the
   * system prompt and the model loads one with `read` when a step's `do:` text
   * asks for it — the engine never parses or injects skill content itself.
   */
  skillPaths?(): string[];
  /** Appended to the DO system prompt. */
  stepSystemPromptSuffix?(): string | undefined;
  /** Seam for tests. */
  createSession?: typeof createStepSession;
  /** Seam for tests. */
  checkDeps?: AdversarialCheckDeps;
}

/**
 * "done" = report_done was called on THIS pass. "already-done" = the step had
 * already reported done before this pass started (a user-approved gate, or a
 * crash between report_done and the check).
 *
 * The distinction is what makes the manual gate work. Both look identical in the
 * marker files, so without it an approved gate re-arms itself forever: the
 * manual-step marker is still set, the loop sees "done + manual step" again and
 * stops for a review that already happened. driver.ts drew the same line between
 * its Case 1 (a done tag in the latest message) and Case 2 (the done marker from
 * an earlier turn).
 */
type DoOutcome = "done" | "already-done" | "gone" | "stalled";

export function createRunner(engine: Engine, initialEvents: RunnerEvents = {}, deps: RunnerDeps = {}) {
  const createSession = deps.createSession ?? createStepSession;

  /**
   * The runner has exactly one caller of these callbacks internally (`events.
   * onXxx?.(...)`, unchanged below), but now potentially several consumers:
   * the chat session's "post into the transcript" listener lives for the
   * whole process, and a run-view's listener is added only while a human is
   * actively attached (see attachRunView in tui/embed.ts) and removed on
   * detach. `events` stays a single object with the same shape so every
   * existing call site below is untouched — it just fans out to whichever
   * listeners are currently registered instead of being one fixed sink.
   */
  const listeners = new Set<RunnerEvents>([initialEvents]);
  const events: Required<RunnerEvents> = {
    onStepStart: (instId, stepId, phase, attempt) => { for (const l of listeners) l.onStepStart?.(instId, stepId, phase, attempt); },
    onStepEvent: (instId, stepId, phase, event) => { for (const l of listeners) l.onStepEvent?.(instId, stepId, phase, event); },
    onVerdict: (instId, stepId, result) => { for (const l of listeners) l.onVerdict?.(instId, stepId, result); },
    onMessage: (instId, text) => { for (const l of listeners) l.onMessage?.(instId, text); },
    onGate: (instId, stepId) => { for (const l of listeners) l.onGate?.(instId, stepId); },
    onPaused: (instId, state) => { for (const l of listeners) l.onPaused?.(instId, state); },
    onStalled: (instId, stepId, attempts) => { for (const l of listeners) l.onStalled?.(instId, stepId, attempts); },
    onCompleted: (instId, reportPath) => { for (const l of listeners) l.onCompleted?.(instId, reportPath); },
  };

  /** Attach an additional listener; call the returned function to detach it. */
  function addEventListener(l: RunnerEvents): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  }
  /** In-process guard: one loop per instance. Also the abort registry. */
  const loops = new Map<string, Promise<void>>();
  const activeStepSessions = new Map<string, SessionHandle>();
  /** Pending "revise this gated step" instructions, consumed by the next DO turn. */
  const pendingRevisions = new Map<string, string>();
  /**
   * instIds that got a live human message since the loop last checked. A human
   * talking to the session is not the model going silent, so that cycle must not
   * burn the keep-alive budget — see sendUserMessage and its use in runDoPhase.
   */
  const humanSteered = new Set<string>();

  /** Platform seam: destroyInstance aborts a DO session running in this process. */
  function abortActiveStep(instId: string): void {
    const session = activeStepSessions.get(instId);
    if (!session) return;
    activeStepSessions.delete(instId);
    Promise.resolve().then(() => session.abort()).catch(() => {}).then(() => session.dispose()).catch(() => {});
  }

  function isRunning(instId: string): boolean {
    return loops.has(instId);
  }

  /** Start the loop for an instance unless one is already running for it. */
  function ensureRunning(instId: string): void {
    if (loops.has(instId)) return;
    const loop = runLoop(instId)
      .catch((e: any) => {
        engine.diag(`[runner] loop crashed for ${instId}:`, e?.stack || e?.message || String(e));
        engine.logEvent(instId, "error", "runner_loop_crashed", { error: e?.message });
      })
      .finally(() => {
        loops.delete(instId);
        engine.clearRunnerPid(instId);
      });
    loops.set(instId, loop);
  }

  /**
   * The user reviewed a manual step and wants changes before verification.
   * Re-open that step's DO session with their instruction and re-arm the gate —
   * the opposite of approving it. The instruction is consumed by the next DO turn.
   */
  function reviseGate(instId: string, instruction: string): void {
    if (!engine.instanceExists(instId)) return;
    const text = String(instruction || "").trim();
    if (!text) return;
    pendingRevisions.set(instId, text);
    engine.clearManualGate(instId);
    engine.clearDoneReported(instId); // must re-run DO, not go to CHECK
    engine.logEvent(instId, "info", "manual_gate_revise", { instruction: text.slice(0, 200) });
    ensureRunning(instId);
  }

  /**
   * Steer the live DO session with a human-typed message. Only meaningful while
   * a DO turn is actually running — CHECK is independent and read-only by
   * design, and there's nothing to steer once the step has moved on. Returns
   * whether the message actually had somewhere to go.
   */
  function sendUserMessage(instId: string, text: string): boolean {
    const value = String(text || "").trim();
    if (!value) return false;
    const session = activeStepSessions.get(instId);
    if (!session) return false;
    const state = engine.readState(instId);
    if (!state || !state.active || state.paused || state.current_phase !== "do") return false;
    humanSteered.add(instId);
    void session.steer(value).catch((e: any) =>
      engine.logEvent(instId, "warn", "steer_failed", { error: e?.message }));
    return true;
  }

  /** Await every in-flight loop (tests; shutdown). */
  async function idle(): Promise<void> {
    while (loops.size > 0) await Promise.all([...loops.values()]);
  }

  /**
   * Pause every instance this process is driving. Called on SIGINT/exit: the
   * step transcripts are already on disk, so `ralphflow_continue` resumes the
   * very session that was interrupted rather than restarting the step.
   */
  function pauseAllForShutdown(): void {
    for (const instId of loops.keys()) {
      const state = engine.readState(instId);
      if (state && state.active && !state.paused) {
        engine.writeState({ ...state, paused: true, pause_reason: "session_aborted" }, instId);
        engine.logEvent(instId, "warn", "session_aborted", { instance: instId, step: state.current_step, phase: state.current_phase });
      }
      abortActiveStep(instId);
      engine.clearRunnerPid(instId);
    }
  }

  // ─── The loop ───────────────────────────────────────────────────────────────

  async function runLoop(instId: string): Promise<void> {
    engine.writeRunnerPid(instId);

    for (;;) {
      const state = engine.readState(instId);
      // Gone: completed (destroyInstance) or cancelled by anyone.
      if (!state || !state.active) return;
      if (state.paused) {
        events.onPaused?.(instId, state);
        return;
      }

      const workflow = engine.loadWorkflow(state.workflow_name);
      if (!workflow) {
        // Workflow YAML deleted after the instance was created — pause instead
        // of stalling silently (driver.ts did the same).
        pause(instId, state, "config_error", `工作流 "${state.workflow_name}" 未找到。`);
        continue;
      }
      const step = engine.getStep(workflow, state.current_step);
      if (!step) {
        pause(instId, state, "config_error", `步骤 "${state.current_step}" 在工作流 "${state.workflow_name}" 中未找到。`);
        continue;
      }
      if (isSubWorkflowStep(step)) {
        // Normal flow enters sub-workflows inline through the transition logic;
        // landing here means a resume found the state parked on one. Resolve it.
        const entry = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step);
        if (entry.error) {
          pause(instId, state, "config_error", entry.text);
        } else {
          events.onMessage?.(instId, entry.text);
        }
        continue;
      }

      // ── CHECK re-entry ──
      // A state already in "check" means either a continue cleared a check_error
      // pause, or a crash landed here. Either way: verify, don't re-run DO.
      if (state.current_phase === "check") {
        const finished = await runCheckAndAdvance(instId, workflow, step, state);
        if (finished) return;
        continue;
      }

      // ── DO ──
      const outcome = await runDoPhase(instId, workflow, step, state);
      if (outcome === "gone") return;
      if (outcome === "stalled") return; // user's turn; state deliberately NOT paused

      // ── Manual review gate: BEFORE the check, never after ──
      // The user's ralphflow_continue is the approval that starts verification.
      if (engine.markerExists(MANUAL_STEP_MARKER, instId)) {
        if (outcome === "done") {
          // Just finished a manual step → stop for review.
          engine.writeManualGate(instId);
          engine.logEvent(instId, "info", "manual_gate_armed", { step: step.id });
          events.onGate?.(instId, step.id);
          events.onMessage?.(instId,
            `📋 手动步骤 \`${step.id}\` 已完成，等待你的审查。\n\n- 满意后运行 /ralphflow-continue 进入独立验证\n- 需要修改直接在对话里说明，修改完成后会再次提示审查\n- 放弃可运行 /ralphflow-cancel`);
          return; // ralphflow_continue re-enters the loop
        }
        // Re-entered on a step that had already reported done. If the gate is
        // still armed the user hasn't approved yet — stay out of their way.
        // If it's gone, ralphflow_continue cleared it: that IS the approval.
        if (engine.markerExists(MANUAL_GATE_MARKER, instId)) return;
      }

      const fresh = engine.readState(instId);
      if (!fresh || !fresh.active) return;
      const finished = await runCheckAndAdvance(instId, workflow, step, fresh);
      if (finished) return;
    }
  }

  function pause(instId: string, state: RalphFlowState, reason: string, failure: string): void {
    engine.writeState({ ...state, paused: true, pause_reason: reason, last_failure_reason: failure }, instId);
    engine.logEvent(instId, "warn", "workflow_paused", { workflow: state.workflow_name, step: state.current_step, reason });
  }

  // ─── DO phase ───────────────────────────────────────────────────────────────

  /**
   * Drive one step's DO phase to `report_done`.
   *
   * Session identity is the interesting part. `resumeSession` is true only when
   * this step is being retried after its own check failed (state carries a
   * last_failure_reason and the attempt dir already exists) — then the model
   * keeps the context of what it just tried. Any other entry (a new step, a
   * route from elsewhere) opens a fresh attempt dir, and therefore a fresh
   * context window.
   */
  async function runDoPhase(instId: string, workflow: WorkflowDef, step: NormalStepDef, state: RalphFlowState): Promise<DoOutcome> {
    // A DO that already reported done (a gate the user just approved, or a crash
    // between report_done and the check) must not be re-run — the work exists.
    if (engine.doneReported(instId)) return "already-done";

    // A gate revision resumes the SAME session (so the model keeps what it built)
    // and leads with the user's requested change.
    const revision = pendingRevisions.get(instId);
    const attemptDir = revision !== undefined
      ? (engine.listStepSessionDirs(instId, step.id, "do").slice(-1)[0] ?? pickAttemptDir(instId, step.id, state))
      : pickAttemptDir(instId, step.id, state);
    const model = deps.currentModel?.() ?? {};
    let session: SessionHandle;
    try {
      session = await createSession({
        cwd: engine.projectDir,
        model: model.model,
        thinkingLevel: model.thinkingLevel,
        sessionDir: attemptDir,
        customTools: [makeReportDoneTool(engine, instId), ...(deps.stepTools?.(instId) ?? [])],
        appendSystemPrompt: deps.stepSystemPromptSuffix?.(),
        skillPaths: deps.skillPaths?.(),
      });
    } catch (e: any) {
      pause(instId, state, "config_error", `无法创建步骤会话：${e.message}`);
      events.onMessage?.(instId, `## ⚠️ 无法创建步骤会话\n\n${e.message}\n\n工作流已暂停。解决后运行 \`/ralphflow-continue\` 恢复。`);
      return "gone";
    }
    activeStepSessions.set(instId, session);

    const attempt = (state.fail_count || 0) + 1;
    events.onStepStart?.(instId, step.id, "do", attempt);

    // Track tool activity per turn: a model that is calling tools is working,
    // not stuck, so its keep-alive budget must not be burned.
    let turnHadToolCalls = false;
    let compacted = false;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_start") turnHadToolCalls = true;
      if (event.type === "compaction_end") compacted = true;
      events.onStepEvent?.(instId, step.id, "do", event);
    });

    try {
      const reinjectKey = `${step.id}:do`;
      // First turn: a gate revision leads with the user's change (resuming the
      // same session); otherwise the DO prompt itself (already cached).
      let message: string;
      if (revision !== undefined) {
        pendingRevisions.delete(instId);
        message = `用户审查了这一步的成果，要求如下修改：\n\n${revision}\n\n请据此调整，完成后再次调用 report_done 工具。`;
      } else {
        message = engine.readDoPromptCache(instId)
          ?? engine.buildDoPrompt(instId, step, state.user_task, state.last_failure_reason, state.fail_count || undefined);
      }

      await session.prompt(message);

      for (;;) {
        if (engine.doneReported(instId)) {
          engine.clearReinjectCounter(instId);
          return "done";
        }
        const cur = engine.readState(instId);
        if (!cur || !cur.active || cur.paused) return "gone"; // cancelled / paused underneath us

        // A human just steered this session — that is engagement, not the model
        // going silent, so this cycle must not burn the keep-alive budget.
        const steered = humanSteered.delete(instId);

        const attempts = turnHadToolCalls || steered
          ? engine.readReinjectCount(instId, reinjectKey)
          : engine.incrementReinjectCount(instId, reinjectKey);

        if (attempts > MAX_DO_REINJECT && !turnHadToolCalls && !steered) {
          // Stop driving, but do NOT pause: the workflow is fine, the model is
          // just stuck. Driving resumes the moment the user says something.
          engine.logEvent(instId, "warn", "do_reinject_exhausted", { step: step.id, attempts });
          events.onStalled?.(instId, step.id, attempts);
          events.onMessage?.(instId,
            `## ⚠️ Ralph Flow 已停止自动驱动\n\n步骤 \`${step.id}\` 的 DO 阶段已连续 ${attempts} 次收到继续提示但未调用 report_done，请人工介入：\n1. 查看任务卡在哪里，补充信息后让模型继续\n2. 若任务实际已完成，运行 /ralphflow-continue 进入验证\n3. 运行 /ralphflow-cancel 取消工作流`);
          return "stalled";
        }

        // A compaction just dropped the task out of context — re-inject the full
        // DO prompt rather than a bare "continue" (driver.ts did this on the
        // session.compacted event). A human message was already steered into the
        // turn directly, so the generic nudge would just be noise stacked right
        // after real feedback — use a short acknowledgement instead.
        const nudge = steered
          ? "（已收到你的补充说明，请据此继续；完成后调用 report_done 工具。）"
          : compacted
          ? `继续执行步骤 \`${step.id}\` 的任务。\n\n${engine.readDoPromptCache(instId) ?? ""}\n\n所有要求满足后调用 \`report_done\` 工具。`
          : `继续执行步骤 \`${step.id}\` 的任务。当所有要求满足后，调用 \`report_done\` 工具。`;
        compacted = false;
        turnHadToolCalls = false;
        await session.followUp(nudge);
      }
    } catch (e: any) {
      if (!engine.instanceExists(instId)) return "gone"; // cancelled mid-turn
      engine.logEvent(instId, "error", "do_session_error", { step: step.id, error: e.message });
      const cur = engine.readState(instId);
      if (cur && cur.active && !cur.paused) {
        pause(instId, cur, "check_error", `步骤会话执行失败：${e.message}`);
        events.onMessage?.(instId, `## ⚠️ 步骤会话执行失败\n\n${e.message}\n\n工作流已暂停（不计入失败次数）。解决后运行 \`/ralphflow-continue\` 恢复。`);
      }
      return "gone";
    } finally {
      unsubscribe();
      if (activeStepSessions.get(instId) === session) activeStepSessions.delete(instId);
      session.dispose();
    }
  }

  /**
   * Where this step attempt's transcript lives.
   *
   * Retrying the same step after ITS check failed resumes the newest attempt dir
   * (fail_count > 0 and a dir exists). Everything else gets a new one — which is
   * what makes "fresh context per step" true rather than aspirational.
   */
  /**
   * Where this step attempt's transcript lives.
   *
   * Two conditions must BOTH hold to resume an existing session:
   *  1. The state carries failure context (a check just rejected something, and
   *     we are here to fix it — fail_count > 0, last_failure_reason present).
   *  2. THIS specific step has been attempted before (its session dir exists).
   *
   * Together they mean "we came back to a step that already ran, with a reason
   * to fix it." The second condition is the important guard: if on_fail routes
   * to a DIFFERENT step that has never been tried, existing is empty → a new
   * session is created (fresh context per step, even during failure routing).
   *
   * The common cases:
   *  - Self-retry (on_fail == this step): resumes, model sees what it just tried.
   *  - Loop-back (test fails → on_fail: implement): resumes implement's own
   *    session so the model has its prior implementation context + the failure.
   *  - Route to a recovery step never run before: fresh session.
   */
  function pickAttemptDir(instId: string, stepId: string, state: RalphFlowState): string {
    const hasFailureContext = (state.fail_count || 0) > 0 && !!state.last_failure_reason;
    const existing = engine.listStepSessionDirs(instId, stepId, "do");
    if (hasFailureContext && existing.length > 0) return existing[existing.length - 1];
    return engine.getStepSessionDir(instId, stepId, "do", existing.length + 1);
  }

  // ─── CHECK phase ────────────────────────────────────────────────────────────

  /** @returns true when the loop should stop (completed, paused, or gone). */
  async function runCheckAndAdvance(instId: string, workflow: WorkflowDef, step: NormalStepDef, state: RalphFlowState): Promise<boolean> {
    // The DO-completion record belongs to the real do→check edge only. This
    // function is re-entered with the state already in "check" (an infra retry
    // after continue, or the crashed-check path), where re-recording would
    // double the report rows.
    if (state.current_phase === "do") {
      engine.logEvent(instId, "info", "done_detected", { step: state.current_step });
      engine.addStepRecord(instId, state.current_step, "do", "passed", state.fail_count || 0);
    }
    engine.clearManualStepMarker(instId);
    engine.clearManualGate(instId);
    engine.clearReinjectCounter(instId);
    engine.clearDoPromptCache(instId);
    engine.clearDoneReported(instId);
    engine.writeState({ ...state, current_phase: "check" }, instId);
    engine.recordStepStart(instId, state.current_step, "check");
    engine.logEvent(instId, "info", "step_start", { step: state.current_step, phase: "check" });
    events.onStepStart?.(instId, step.id, "check", (state.fail_count || 0) + 1);

    const checkPrompt = engine.buildCheckPrompt(instId, step, state.user_task);

    let checkResult;
    try {
      checkResult = await adversarialCheck(
        engine, instId, step, checkPrompt, state.user_task, workflow.adversarial_check,
        undefined, // onBashEvent: superseded by the live event stream below
        deps.checkDeps,
        (event) => events.onStepEvent?.(instId, step.id, "check", event),
      );
    } catch (err: any) {
      engine.logEvent(instId, "error", "adversarial_check_uncaught", { stepId: step.id, error: err.message });
      const st = engine.readState(instId);
      if (st && st.active && st.current_phase === "check" && st.current_step === state.current_step && st.workflow_name === state.workflow_name) {
        engine.writeState({ ...st, paused: true, pause_reason: "check_error", last_failure_reason: `对抗性检查崩溃：${err.message}` }, instId);
      }
      events.onMessage?.(instId, `## ⚠️ 验证未能运行\n\n对抗性检查崩溃：${err.message}\n\n工作流已暂停（不计入失败次数，已完成的工作保持原样）。问题解决后运行 \`/ralphflow-continue\` 重新验证。`);
      return true;
    }

    // The state may have moved while the check ran (a cancel, a continue from
    // another process, a shutdown pause). Applying a stale verdict would clear
    // someone else's pause and drive a workflow that has moved on — discard it.
    const cur = engine.readState(instId);
    if (!cur || !cur.active || cur.paused || cur.current_phase !== "check"
        || cur.workflow_name !== state.workflow_name || cur.current_step !== state.current_step) {
      engine.logEvent(instId, "warn", "check_result_discarded", { reason: cur?.paused ? "instance paused during check" : "state changed during check" });
      return true;
    }

    events.onVerdict?.(instId, step.id, { passed: checkResult.passed, infra: checkResult.infra, reason: checkResult.reason });

    // Infra failure: no verdict was produced. Pause in check WITHOUT burning a
    // fail count — the work is fine, the verifier isn't.
    if (checkResult.infra) {
      engine.writeState({ ...cur, paused: true, pause_reason: "check_error", last_failure_reason: checkResult.reason }, instId);
      engine.logEvent(instId, "warn", "workflow_paused", { workflow: cur.workflow_name, step: cur.current_step, reason: "check_infra_error" });
      events.onMessage?.(instId,
        `## ⚠️ 验证未能运行\n\n${checkResult.reason}\n\n这是验证进程自身的问题（额度/API/超时），**不是**工作成果的问题：本次不计入失败次数，已完成的工作无需重做。问题解决后运行 \`/ralphflow-continue\` 直接重新验证。`);
      const p = engine.readState(instId);
      if (p) events.onPaused?.(instId, p);
      return true;
    }

    engine.addStepRecord(instId, cur.current_step, "check", checkResult.passed ? "passed" : "failed", cur.fail_count || 0, checkResult.reason);
    const result = checkResult.passed
      ? engine.handleCheckPassed(instId, cur, workflow, step, checkResult)
      : engine.handleCheckFailed(instId, cur, workflow, step, checkResult);

    // Arm the next DO phase's markers before emitting the transition text
    // (handleCheckPassed/Failed already wrote the state and cached the prompt).
    if (!result.completed && !result.paused) {
      const next = engine.readState(instId);
      if (next && next.active && next.current_phase === "do") {
        engine.clearDoneReported(instId);
        engine.clearManualGate(instId);
        const nextWf = next.workflow_name === workflow.name ? workflow : engine.loadWorkflow(next.workflow_name);
        if (nextWf?.manual_step?.includes(next.current_step)) engine.writeManualStepMarker(instId);
        else engine.clearManualStepMarker(instId);
      }
    }

    // Only a transition that needs the user (paused/completed) reaches the
    // permanent chat listener — an ordinary silent pass-and-advance or
    // fail-and-retry is exactly what "runs in the background, tells you when
    // it needs you" promises NOT to surface unprompted. The run view (if
    // attached) already shows every attempt live via onStepStart/onStepEvent/
    // onVerdict, independent of onMessage, so nothing here is lost by staying
    // quiet — only who gets told, and when.
    if (result.completed || result.paused) events.onMessage?.(instId, result.text);
    if (result.completed) {
      // The instance dir is gone now, but the archived report survives here.
      const reportPath = path.join(engine.getReportsDir(), `${instId}-final-report.md`);
      events.onCompleted?.(instId, fs.existsSync(reportPath) ? reportPath : undefined);
      return true;
    }
    if (result.paused) {
      const paused = engine.readState(instId);
      if (paused) events.onPaused?.(instId, paused);
      return true;
    }
    return false; // keep looping into the next step's DO
  }

  return { ensureRunning, reviseGate, sendUserMessage, addEventListener, abortActiveStep, isRunning, idle, pauseAllForShutdown };
}

export type Runner = ReturnType<typeof createRunner>;
