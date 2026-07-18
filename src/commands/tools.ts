/**
 * The six ralphflow_* tools, exposed to the main chat session.
 *
 * Names and response texts are a verbatim port of the plugin versions' tools, so
 * the workflow YAML, the docs and the user's muscle memory all carry over.
 *
 * Two runtime differences (SYNC.md has the full list):
 *
 *  - The plugins ran the CHECK from an idle event, so ralphflow_continue was
 *    "pure state management" that promised verification would happen "when you
 *    go idle". Here the runner owns execution: continue mutates the state and
 *    then calls ensureRunning, and the loop does the rest. The user-facing texts
 *    say "自动" either way; only the mechanism moved.
 *  - opencode needed no lock (one plugin process per project). A `ralph` CLI is
 *    an ordinary process, so every state mutation takes the cross-process
 *    instance lock, and start/continue refuse an instance another live process
 *    is already driving.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { Type } from "typebox";
import type { Engine } from "../engine/core.js";
import { DONE_REPORTED_MARKER, MANUAL_GATE_MARKER, MAX_NESTING_DEPTH } from "../engine/core.js";
import { hasActiveCheck } from "../engine/check.js";
import { isInstanceGone, withInstanceLock } from "../engine/lock.js";
import type { Runner } from "../engine/runner.js";
import { formatSkillReport, loadSkillIndex } from "../engine/skills.js";
import { isSubWorkflowStep, type RalphFlowState, type StepDef } from "../engine/types.js";
import { defineTool, type ToolDefinition } from "../pi/adapter.js";
import { attachRunView, type UiCustomHost } from "../tui/embed.js";
import type { RunInstanceOutcome } from "../tui/run-app.js";

export interface ToolsContext {
  engine: Engine;
  runner: Runner;
  /** Id of the main chat session — the ownership token in state.session_id. */
  getSessionId(): string;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
/**
 * `terminate: true` (AgentToolResult, pi-agent-core) tells pi's agent loop to
 * stop after this tool batch instead of invoking the model again. Set on a
 * detach so the turn ends there and then — the same effect the user
 * confirmed by hand (Esc the run view, then Esc again in chat to abort the
 * agent's turn): this makes that automatic, one Esc instead of two.
 */
const terminateText = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {}, terminate: true });

/**
 * Appended after ralphflow_start/continue/watch attach the run view and it
 * later gives control back — either the workflow reached a terminal state,
 * or the user detached (Esc on an empty input) while it was still going.
 * Names the exact way back in (the /ralphflow-watch command, or just asking)
 * so the answer to "how do I check on it" is right there, not something the
 * user has to already know.
 */
function describeAttachOutcome(result: RunInstanceOutcome): string {
  if (result.outcome === "completed") {
    return `\n\n---\n\n## 工作流完成 ✓${result.reportPath ? `\n\n执行报告：${result.reportPath}` : ""}`;
  }
  if (result.outcome === "cancelled") {
    return "\n\n---\n\n工作流已取消。";
  }
  return "\n\n---\n\n已切回聊天。工作流在后台继续运行。想再看实时进度：直接说\"看着它跑\"，或者输入 `/ralphflow-watch`。不需要的话不用管它——它需要人工审查、遇到暂停，或者跑完时，会自动出现在这个对话里。";
}

/**
 * `terminate: true` alone was NOT enough — confirmed against a real model in
 * a real terminal (deepseek-v4-flash, 2026-07-18): after a detach, it was
 * invoked again anyway, said "The workflow is running in the background. Let
 * me watch it to see the progress," and called ralphflow_watch. Pi's own doc
 * comment calls `terminate` a "hint" ("Early termination only happens when
 * EVERY finalized tool result in the batch sets this to true") — if the model
 * called anything else alongside ralphflow_start in the same turn, one
 * non-terminating result anywhere in that batch silently defeats it for the
 * whole turn. When that happened here, the model didn't just re-call
 * ralphflow_watch — it read the DO step's own tool-call log line in the
 * transcript (posted by runner.ts's permanent onStepEvent listener, e.g.
 * "▸ [create] bash mkdir -p ...") as if addressed to itself, and started
 * executing that command with its OWN bash tool — a second agent racing the
 * real DO session on the same files.
 *
 * `ExtensionContext.abort()` — the same "abort the current agent operation"
 * primitive a manual Esc-in-chat triggers, per the user's own working manual
 * test — is what actually stopped it: unconditional, doesn't depend on every
 * tool in a batch cooperating. `setActiveTools`/`getActiveTools` were tried
 * as a second layer here first, but don't actually exist on Pi 0.80.10's real
 * interactive-mode UI context despite being declared in ExtensionUIContext's
 * types — confirmed by grepping the compiled interactive-mode.js for a real
 * implementation (none) and by a real run throwing "ctx.ui.getActiveTools is
 * not a function" from the "input" handler that tried to use it. Removed
 * rather than left in as a guarded no-op: dead code that silently does
 * nothing is worse than no code, because it reads as a working second layer
 * of defense when it is not one.
 */
function attachResult(prefix: string, result: RunInstanceOutcome, ctx: UiCustomHost) {
  const body = prefix + describeAttachOutcome(result);
  if (result.outcome !== "detached") return text(body);
  ctx.abort?.();
  return terminateText(body);
}

/**
 * The state-machine core of "continue": approve a manual review / resume a
 * paused workflow / recover from a crash / attach to an instance interrupted
 * mid-DO. Pulled out of the `ralphflow_continue` tool so `ralphflow continue`
 * (the headless CLI verb in headless.ts) can drive the exact same six
 * branches without a chat session or a run-view attach — headless has no
 * `ctx.ui.custom()` to borrow a terminal from, and doesn't need one: this
 * function only mutates state and returns what happened, it never touches
 * the runner or the UI. Caller is responsible for the instance lock (both
 * call sites already need `withInstanceLock` for other reasons) and for
 * calling `runner.ensureRunning(instId)` afterward.
 *
 * `attached`: true when the caller does NOT already own this instance's
 * session — this is what makes branch 5 (crash-recovery re-attach) reachable.
 * Headless callers always pass true: a one-shot CLI invocation has no
 * standing session identity to already "be" the owner of anything.
 */
export function resolveContinueAction(engine: Engine, instId: string, sessionId: string, attached: boolean): string {
  engine.bindInstance(instId, sessionId);

  let state = engine.readState(instId);
  if (!state || !state.active) {
    return "没有活跃的工作流。使用 ralphflow_start 启动一个。";
  }

  const workflow = engine.loadWorkflow(state.workflow_name);
  if (!workflow) {
    return `工作流 "${state.workflow_name}" 未找到。`;
  }

  // 1. check_error pause: the verifier couldn't run. Reset to check phase
  //    (the work is untouched) — the runner re-verifies immediately.
  if (state.paused && state.pause_reason === "check_error" && state.current_phase === "check") {
    const step = engine.getStep(workflow, state.current_step);
    if (step && !isSubWorkflowStep(step)) {
      engine.writeState({ ...state, paused: false, pause_reason: undefined }, instId);
      engine.logEvent(instId, "info", "check_retry_after_infra_error", { workflow: state.workflow_name, step: step.id });
      return "验证基础设施故障已清除，工作流恢复。正在重新验证。";
    }
  }

  // 2. manual gate: the user approves the work. Clearing the gate IS the
  //    approval — the runner then verifies. Do NOT touch the done-reported
  //    marker: the runner needs it to know the DO phase is finished.
  if (engine.markerExists(MANUAL_GATE_MARKER, instId)) {
    engine.clearManualStepMarker(instId);
    engine.clearManualGate(instId);
    engine.logEvent(instId, "info", "manual_gate_approved", { step: state.current_step });
    return `## ✅ 审查通过\n\n步骤 \`${state.current_step}\` 已批准。正在运行独立验证。`;
  }

  // 3. Paused (max_failures / config_error / session_*): reset fail_count
  //    and re-issue the DO prompt for a fresh attempt.
  if (state.paused) {
    const previousFailCount = state.fail_count;
    const previousReason = state.last_failure_reason;
    engine.clearReinjectCounter(instId);
    engine.clearDoneReported(instId);
    engine.clearManualGate(instId);
    engine.writeState({ ...state, current_phase: "do", paused: false, pause_reason: undefined, fail_count: 0 }, instId);
    engine.logEvent(instId, "info", "workflow_resumed", { workflow: state.workflow_name, step: state.current_step });

    const step = engine.getStep(workflow, state.current_step);
    if (!step) {
      return `已恢复。当前步骤：${state.current_step}`;
    }

    if (isSubWorkflowStep(step)) {
      engine.recordStepStart(instId, step.id, "do");
      engine.logEvent(instId, "info", "step_start", { step: step.id, phase: "do" });
      // Peek the stack top before pushing our own return-address frame for
      // this entry attempt. Two cases:
      //  - it already matches (workflow_name, current_step) exactly → an
      //    earlier attempt at this SAME entry (crashed or interrupted before
      //    it could resolve) left a duplicate frame; leave it popped so the
      //    push below replaces it instead of stacking a second copy.
      //  - it's anything else (an outer nesting level's real return address,
      //    or nothing) → not ours to touch; push it straight back before
      //    layering our own frame on top, so outer context survives.
      const staleTop = engine.popState(instId);
      const staleIsMismatch = staleTop && !(staleTop.workflow_name === state.workflow_name && staleTop.current_step === state.current_step);
      if (staleIsMismatch) {
        engine.pushState(staleTop!, instId);
      }
      engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: 0, paused: false, pause_reason: undefined }, instId);
      const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step, MAX_NESTING_DEPTH, previousReason, previousFailCount);
      if (subResult.error) {
        engine.popState(instId); // undo our push
        if (staleIsMismatch) engine.popState(instId); // also undo the stale push-back
        engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
        return subResult.text;
      }
      let resumeMsg = `## 工作流已恢复\n\n之前尝试次数：${previousFailCount}`;
      if (previousReason) resumeMsg += `\n\n### 上次失败原因\n${previousReason}`;
      resumeMsg += "\n\n---\n\n";
      return resumeMsg + `重新进入子工作流：**${step.id}**`;
    }

    if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
      engine.writeManualStepMarker(instId);
    }
    engine.buildDoPrompt(instId, step, state.user_task, previousReason, previousFailCount);
    let resumeMsg = `## 工作流已恢复\n\n之前尝试次数：${previousFailCount}`;
    if (previousReason) resumeMsg += `\n\n### 上次失败原因\n${previousReason}`;
    return resumeMsg + `\n\n---\n\n重新执行步骤 **${step.id}** - ${step.desc}`;
  }

  // 4. Crash recovery: stuck in check phase with no active verifier →
  //    reset to do and re-run the step.
  if (state.current_phase !== "do") {
    if (state.current_phase === "check") {
      if (hasActiveCheck(instId)) {
        engine.logEvent(instId, "info", "crash_recovery_skipped", { step: state.current_step });
        return `## ⏳ 验证进行中\n\n步骤 **${state.current_step}** 的对抗性检查仍在运行。\n\n请等待完成，或使用 \`/ralphflow-cancel\` 取消工作流。`;
      }
      engine.clearAdversarialSession(instId);
      engine.logEvent(instId, "warn", "crash_recovery", { step: state.current_step });
      state = { ...state, current_phase: "do" };
      engine.writeState(state, instId);
      engine.clearReinjectCounter(instId);
      engine.clearManualStepMarker(instId);
      engine.clearManualGate(instId);
      engine.clearDoneReported(instId);
      const step = engine.getStep(workflow, state.current_step);
      if (!step) {
        return `崩溃恢复：步骤 "${state.current_step}" 在工作流中未找到。`;
      }
      if (isSubWorkflowStep(step)) {
        // Same peek-and-dedup as the paused-resume branch above: replace a
        // duplicate frame left by an earlier crashed attempt at this exact
        // entry, but leave any genuinely different (outer) frame untouched.
        const staleTop = engine.popState(instId);
        const staleIsMismatch = staleTop && !(staleTop.workflow_name === state.workflow_name && staleTop.current_step === state.current_step);
        if (staleIsMismatch) {
          engine.pushState(staleTop!, instId);
        }
        engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: state.fail_count || 0 }, instId);
        const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step, MAX_NESTING_DEPTH, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
        if (subResult.error) {
          engine.popState(instId); // undo our push
          if (staleIsMismatch) engine.popState(instId); // also undo the stale push-back
          engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
          return subResult.text;
        }
        return `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。\n\n---\n\n重新进入子工作流：**${step.id}**`;
      }
      if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
        engine.writeManualStepMarker(instId);
      }
      engine.buildDoPrompt(instId, step, state.user_task, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
      return `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。DO 阶段已重置。\n\n---\n\n重新执行步骤 **${step.id}** - ${step.desc}`;
    }
    return `当前阶段是 "${state.current_phase}"，不是 "do"。工作流已在处理中。`;
  }

  const step = engine.getStep(workflow, state.current_step);
  if (!step) return `步骤 "${state.current_step}" 未找到。`;

  // 5. Attach: taking over an instance that died MID-DO (nothing reported,
  //    no manual gate). Re-issue the DO prompt.
  if (attached && !engine.markerExists(DONE_REPORTED_MARKER, instId) && !engine.markerExists(MANUAL_GATE_MARKER, instId)) {
    if (isSubWorkflowStep(step)) {
      engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: state.fail_count || 0 }, instId);
      const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step, MAX_NESTING_DEPTH, state.last_failure_reason, state.fail_count || 0);
      if (subResult.error) {
        engine.popState(instId);
        engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
        return subResult.text;
      }
      engine.logEvent(instId, "info", "instance_attached_resume_do", { instance: instId, step: step.id });
      return `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行子工作流。\n\n---\n\n重新进入：**${step.id}**`;
    }
    if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
      engine.writeManualStepMarker(instId);
    }
    engine.buildDoPrompt(instId, step, state.user_task, state.last_failure_reason, state.fail_count || 0);
    engine.logEvent(instId, "info", "instance_attached_resume_do", { instance: instId, step: step.id });
    return `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行当前步骤。\n\n---\n\n重新执行步骤 **${step.id}** - ${step.desc}`;
  }

  // 6. In do, no gate, no pause, no attach. The runner is already on it —
  //    or, if this process just started, ensureRunning below puts it back
  //    on the rails.
  return "没有需要手动继续的操作。引擎会自动执行 DO 与验证阶段。";
}

export function createTools(ctx: ToolsContext): ToolDefinition[] {
  const { engine, runner, getSessionId } = ctx;

  /** Run a mutation under the instance lock, mapping a vanished instance to a message. */
  async function locked(instId: string, fn: () => string | Promise<string>): Promise<string> {
    try {
      return await withInstanceLock(engine.getInstanceDir(instId), instId, fn);
    } catch (e: any) {
      if (isInstanceGone(e)) return `实例 \`${instId}\` 已经不存在（可能刚被其他进程取消或完成）。`;
      throw e;
    }
  }

  /** Refuse to touch an instance another live process is driving. */
  function foreignDriverNote(instId: string): string | null {
    const pid = engine.foreignRunnerPid(instId);
    if (pid === null) return null;
    return `实例 \`${instId}\` 正被另一个 ralph 进程（pid ${pid}）驱动。请在那个进程里操作它，或先结束该进程。`;
  }

  function stepsOverview(steps: StepDef[]): string {
    return steps.map((s, i) => `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}`).join("\n");
  }

  // ─── ralphflow_start ────────────────────────────────────────────────────────

  const ralphflow_start = defineTool({
    name: "ralphflow_start",
    label: "Ralph Flow: Start",
    description: "Start a workflow instance. Provide workflow name and task description. A session can run several instances at once — this does not refuse just because the session already has one active.",
    // Same-turn batches of ralphflow_* tool calls must not overlap: attachRunView
    // borrows the ONE shared TUI via ctx.ui.custom(), which has no reentrancy
    // guard on pi's side. With ownership no longer capped at one instance per
    // session, a second start/continue/watch in the same batch could otherwise
    // race the first for that terminal. Declaring this "sequential" makes pi
    // run the whole batch one call at a time instead of in parallel — see
    // pi-agent-core's executeToolCallsParallel/executeToolCallsSequential.
    executionMode: "sequential",
    parameters: Type.Object({
      workflow: Type.String({ description: "Workflow name (use ralphflow_list to see available workflows)" }),
      task: Type.String({ description: "Task description - what should be accomplished" }),
      extra_dirs: Type.Optional(Type.Array(Type.String(), {
        description: "Directories OUTSIDE the project that the task's source material lives in (absolute paths or ~/...). The independent CHECK verifier gets read access to them; each must exist or the start is refused.",
      })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx: UiCustomHost) => {
      const sessionId = getSessionId();
      const { workflow, task } = params;
      const extra_dirs = params.extra_dirs ?? [];

      const instances = engine.listInstances();

      const workflowProblems: string[] = [];
      const workflowDef = engine.loadWorkflow(workflow, workflowProblems);
      if (!workflowDef) {
        if (workflowProblems.length > 0) {
          return text(`工作流 "${workflow}" 定义无效，无法启动：\n${workflowProblems.map((p) => `- ${p}`).join("\n")}\n\n请修复工作流 YAML 后重试。`);
        }
        const available = engine.listWorkflows();
        return text(available.length > 0
          ? `工作流 "${workflow}" 未找到。可用工作流：\n${available.map((w) => `- ${w.name}: ${w.desc}`).join("\n")}`
          : "没有找到工作流。请在 .ralph-flow/workflows/ 目录创建工作流定义文件。");
      }

      const firstStep = workflowDef.steps[0];
      if (!firstStep) return text("工作流没有步骤。");

      // Validate extra_dirs before creating anything.
      const home = os.homedir() || "";
      const resolvedExtraDirs: string[] = [];
      for (const d of extra_dirs) {
        let p = String(d).trim();
        if (!p) continue;
        if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
        if (!path.isAbsolute(p)) p = path.resolve(engine.projectDir, p);
        let st = null;
        try { st = fs.statSync(p); } catch {}
        if (!st || !st.isDirectory()) {
          return text(`extra_dirs 校验失败：\`${d}\`（解析为 \`${p}\`）不存在或不是目录。请修正后重新启动。`);
        }
        resolvedExtraDirs.push(p);
      }

      // Create a fresh instance owned by this session.
      const instId = engine.generateInstanceId(workflow);
      fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
      engine.writeArtifactsDirName(instId, task);
      engine.writeExtraDirs(instId, resolvedExtraDirs);

      const othersNote = instances.length > 0
        ? `\n\n> ℹ️ 本目录下另有 ${instances.length} 个工作流实例，使用 /ralphflow-status 查看。`
        : "";
      const extraDirsNote = resolvedExtraDirs.length > 0
        ? `\n\n验证器额外可读目录：${resolvedExtraDirs.map((d) => `\`${d}\``).join("、")}`
        : "";
      const baseState: RalphFlowState = { active: true, workflow_name: workflow, current_step: firstStep.id, current_phase: "do", fail_count: 0, user_task: task, paused: false, session_id: sessionId };
      const overview = stepsOverview(workflowDef.steps);

      if (isSubWorkflowStep(firstStep)) {
        engine.recordStepStart(instId, firstStep.id, "do");
        engine.logEvent(instId, "info", "step_start", { step: firstStep.id, phase: "do" });
        engine.writeState(baseState, instId);
        engine.pushState(baseState, instId);
        const subResult = engine.resolveSubWorkflowEntry(instId, firstStep.workflow, task, firstStep);
        if (subResult.error) {
          try { fs.rmSync(engine.getInstanceDir(instId), { recursive: true, force: true }); } catch {}
          return text(subResult.text);
        }
        engine.logEvent(instId, "info", "workflow_start", { workflow, instance: instId });
        runner.ensureRunning(instId);
        const subStartResult = await attachRunView(ctx, engine, runner, sessionId, instId);
        return attachResult(`工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${overview}\n\n启动子工作流：**${firstStep.id}** → ${firstStep.workflow}${extraDirsNote}${othersNote}`, subStartResult, ctx);
      }

      engine.writeState(baseState, instId);
      engine.logEvent(instId, "info", "workflow_start", { workflow, instance: instId });
      engine.recordStepStart(instId, firstStep.id, "do");
      engine.logEvent(instId, "info", "step_start", { step: firstStep.id, phase: "do" });
      if (workflowDef.manual_step && workflowDef.manual_step.includes(firstStep.id)) {
        engine.writeManualStepMarker(instId);
      }
      // Cache the DO prompt so the runner's first turn uses exactly this text.
      engine.buildDoPrompt(instId, firstStep, task);
      runner.ensureRunning(instId);
      const startResult = await attachRunView(ctx, engine, runner, sessionId, instId);
      return attachResult(`工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${overview}\n\n开始：**${firstStep.id}** - ${firstStep.desc}${extraDirsNote}${othersNote}`, startResult, ctx);
    },
  }) as unknown as ToolDefinition;

  // ─── ralphflow_continue ─────────────────────────────────────────────────────
  //
  // Approve a manual review / resume a paused workflow / attach to an
  // interrupted instance. The six branches are ported one-for-one; what changed
  // is the tail: instead of promising the idle handler will pick it up, each
  // branch hands the instance to the runner.

  const ralphflow_continue = defineTool({
    name: "ralphflow_continue",
    label: "Ralph Flow: Continue",
    description: "Approve a manual review / resume a paused workflow / attach to an interrupted instance. Verification runs automatically — you do not need to trigger it. (Optional instance id, unique prefix allowed.)",
    // See ralphflow_start's executionMode comment — same shared-TUI hazard.
    executionMode: "sequential",
    parameters: Type.Object({
      instance: Type.Optional(Type.String({ description: "Instance id (unique prefix allowed). Only needed to attach to a specific instance from a new session, or to pick one when this session already owns several." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx: UiCustomHost) => {
      const sessionId = getSessionId();
      const resolution = engine.resolveInstance(params.instance, sessionId);
      if (!resolution.ok) return text(resolution.text);
      const instId = resolution.id;
      const attached = resolution.attached;

      const foreign = foreignDriverNote(instId);
      if (foreign) return text(foreign);

      const response = await locked(instId, () => resolveContinueAction(engine, instId, sessionId, attached));

      // Whatever branch ran, the instance is now in a state the loop can drive.
      if (!engine.instanceExists(instId)) return text(response);
      runner.ensureRunning(instId);
      const continueResult = await attachRunView(ctx, engine, runner, sessionId, instId);
      return attachResult(response, continueResult, ctx);
    },
  }) as unknown as ToolDefinition;

  // ─── ralphflow_watch ────────────────────────────────────────────────────────
  //
  // Re-attach the run view to an instance that's already running — the
  // detach-and-keep-running counterpart to ralphflow_start/continue. Mutates
  // nothing by itself: no approval, no resume, no retry. If the instance
  // isn't actually being driven yet (e.g. this is a fresh session picking up
  // something adopted at boot), it just starts driving it, same as continue.

  const ralphflow_watch = defineTool({
    name: "ralphflow_watch",
    label: "Ralph Flow: Watch",
    description: "Attach the live run view to a workflow instance that's already running. Does not approve, resume, or cancel anything by itself. ONLY call this when the user explicitly asks to see the workflow again (\"show me\", \"let's look\", \"attach\"). Detaching (Esc) means the user chose to stop watching — do NOT call this on your own initiative just because a workflow happens to be running in the background; you'll be told in this same chat when it needs you (gate/pause) or finishes, so there's nothing to check on unprompted.",
    // See ralphflow_start's executionMode comment — same shared-TUI hazard.
    executionMode: "sequential",
    parameters: Type.Object({
      instance: Type.Optional(Type.String({ description: "Instance id (unique prefix allowed). Needed whenever this session owns more than one active instance, or to watch one it doesn't own." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx: UiCustomHost) => {
      const sessionId = getSessionId();
      const resolution = engine.resolveInstance(params.instance, sessionId);
      if (!resolution.ok) return text(resolution.text);
      const instId = resolution.id;

      const foreign = foreignDriverNote(instId);
      if (foreign) return text(foreign);

      await locked(instId, () => { engine.bindInstance(instId, sessionId); return ""; });
      if (!engine.instanceExists(instId)) return text(`实例 \`${instId}\` 已经不存在。`);
      runner.ensureRunning(instId);
      const watchResult = await attachRunView(ctx, engine, runner, sessionId, instId);
      return attachResult(`已接管实例 \`${instId}\`。`, watchResult, ctx);
    },
  }) as unknown as ToolDefinition;

  // ─── ralphflow_cancel ───────────────────────────────────────────────────────

  const ralphflow_cancel = defineTool({
    name: "ralphflow_cancel",
    label: "Ralph Flow: Cancel",
    description: "Cancel a workflow instance and clean up its state (optional instance id, unique prefix allowed).",
    parameters: Type.Object({
      instance: Type.Optional(Type.String({ description: "Instance id (unique prefix allowed). Only needed to cancel a specific instance not bound to this session." })),
    }),
    execute: async (_id, params) => {
      const sessionId = getSessionId();
      const resolution = engine.resolveInstance(params.instance, sessionId);
      if (!resolution.ok) return text(resolution.text);
      const instId = resolution.id;
      const state = engine.readState(instId);
      const workflowName = state ? state.workflow_name : instId;
      const ownedElsewhere = state?.session_id && state.session_id !== sessionId;
      const foreignPid = engine.foreignRunnerPid(instId);

      const response = await locked(instId, () => {
        engine.logEvent(instId, "info", "workflow_cancelled", { workflow: workflowName, instance: instId });
        // destroyInstance aborts the sessions this process owns; a runner in
        // another process stops on its next state read.
        const reportPath = engine.destroyInstance(instId, "cancelled");
        let out = `工作流 "${workflowName}"（实例 \`${instId}\`）已取消。`;
        if (reportPath) out += `\n执行报告：${path.relative(engine.projectDir, reportPath)}`;
        if (foreignPid) out += `\n\n> ⚠️ 该实例正被 pid ${foreignPid} 的 ralph 进程驱动。它会在下一次读取状态时停止；已在途的模型调用可能还会跑完当前一轮。`;
        else if (ownedElsewhere) out += `\n\n> ⚠️ 该实例的属主是另一个会话。它的下一次 ralphflow_continue 调用会得到"工作流已取消"。`;
        return out;
      });
      return text(response);
    },
  }) as unknown as ToolDefinition;

  // ─── ralphflow_status ───────────────────────────────────────────────────────
  //
  // Every return here uses terminateText, not text: status is a "report and
  // stop" operation, nothing about it needs a follow-up tool call. Without
  // this, a model could read the status text and decide on its own, in the
  // same turn, to also call ralphflow_watch and take over the screen — the
  // same unwanted chaining `terminate` already prevents on the attach tools,
  // just reached via a different tool combination (status → watch instead of
  // watch → watch). Reported directly by a real user, not a hypothetical.

  const ralphflow_status = defineTool({
    name: "ralphflow_status",
    label: "Ralph Flow: Status",
    description: "Show workflow status: the current session's instance, a specific instance, or an overview of all instances. Only call this when the user asks about status — a workflow running in the background does not need to be checked on; you'll be told in this same chat when it needs you or finishes.",
    parameters: Type.Object({
      instance: Type.Optional(Type.String({ description: "Instance id (unique prefix allowed) to inspect a specific instance." })),
    }),
    execute: async (_id, params) => {
      const sessionId = getSessionId();
      const instances = engine.listInstances();

      // Pick the instance to detail: explicit > owned by this session.
      let target = null as (typeof instances)[number] | null;
      if (params.instance) {
        const wanted = String(params.instance).trim();
        const matches = instances.filter((i) => i.id === wanted);
        const prefixMatches = matches.length > 0 ? matches : instances.filter((i) => i.id.startsWith(wanted));
        if (prefixMatches.length === 1) target = prefixMatches[0];
        else if (prefixMatches.length === 0) {
          return terminateText(instances.length === 0
            ? `没有找到实例 "${wanted}"。当前没有活跃的工作流实例。`
            : `没有找到匹配 "${wanted}" 的实例。\n\n${engine.formatInstanceList(instances)}`);
        } else {
          return terminateText(`前缀 "${wanted}" 匹配到多个实例：\n\n${engine.formatInstanceList(prefixMatches)}`);
        }
      } else {
        const mine = instances.filter((i) => i.owner === sessionId);
        if (mine.length === 1) target = mine[0];
      }

      if (!target) {
        if (instances.length === 0) {
          return terminateText("没有活跃的工作流实例。使用 ralphflow_start 启动一个。");
        }
        return terminateText(engine.formatInstanceList(instances,
          "查看某个实例详情：`ralphflow_status` 传入 `instance` 参数；接管某个实例：`ralphflow_continue` 传入 `instance` 参数（支持唯一前缀）。"));
      }

      const state = target.state;
      const workflow = engine.loadWorkflow(state.workflow_name);
      const currentStep = workflow ? engine.getStep(workflow, state.current_step) : null;
      const foreignPid = engine.foreignRunnerPid(target.id);

      let status = `## 工作流状态

- **实例**: \`${target.id}\`
- **工作流**: ${state.workflow_name}
- **状态**: ${engine.instanceStatusLabel(target)}
- **当前步骤**: ${state.current_step}
- **当前阶段**: ${state.current_phase}
- **失败次数**: ${state.fail_count}
- **属主会话**: ${target.owner ? (target.owner === sessionId ? "🟢 本会话" : `\`${target.owner.slice(0, 8)}\``) : "无"}
- **最后活动**: ${engine.formatLastActivity(target.lastActivity)}`;

      if (foreignPid) status += `\n- **驱动进程**: pid ${foreignPid}（另一个 ralph 进程）`;
      if (state.last_failure_reason) status += `\n- **上次失败原因**: ${state.last_failure_reason}`;

      if (target.manualGate) {
        status += `\n\n> 📋 该实例正在等待手动审查。审查完成后调用 \`ralphflow_continue\` 进入验证阶段。`;
      } else if (target.owner && target.owner !== sessionId) {
        status += `\n\n> ℹ️ 该实例的属主是另一个会话。调用 \`ralphflow_continue\`（必要时带实例 ID）可在当前会话接管并继续。`;
      }

      if (currentStep) {
        if (isSubWorkflowStep(currentStep)) {
          status += `

## 当前步骤详情

- **描述**: ${currentStep.desc}
- **类型**: 子工作流
- **子工作流**: ${currentStep.workflow}
- **输入**: ${currentStep.inputs ? JSON.stringify(currentStep.inputs) : "无"}
- **最大失败次数**: ${currentStep.max_fail_count}`;
        } else {
          status += `

## 当前步骤详情

- **描述**: ${currentStep.desc}
- **任务**: ${currentStep.do}
- **输入**: ${currentStep.input || "无"}
- **输出**: ${currentStep.output || "无"}
- **检查**: ${currentStep.check}
- **最大失败次数**: ${currentStep.max_fail_count}`;
        }
      }

      if (instances.length > 1) {
        status += `\n\n> ℹ️ 本目录共有 ${instances.length} 个活跃实例。不带参数的 ralphflow_status 只显示当前会话的实例；传入 instance 参数查看其他实例。`;
      }

      return terminateText(status);
    },
  }) as unknown as ToolDefinition;

  // ─── ralphflow_list ─────────────────────────────────────────────────────────

  const ralphflow_list = defineTool({
    name: "ralphflow_list",
    label: "Ralph Flow: List",
    description: "List all available workflows and active workflow instances.",
    parameters: Type.Object({}),
    execute: async () => {
      const workflows = engine.listWorkflows();
      let out = workflows.length > 0
        ? `## 可用工作流\n\n${workflows.map((w) => `- **${w.name}**: ${w.desc}`).join("\n")}`
        : "没有找到工作流。请在 .ralph-flow/workflows/ 目录创建工作流定义文件。";
      const instances = engine.listInstances();
      if (instances.length > 0) {
        out += `\n\n---\n\n${engine.formatInstanceList(instances)}`;
      }
      return text(out);
    },
  }) as unknown as ToolDefinition;

  // ─── ralphflow_doctor ───────────────────────────────────────────────────────

  const ralphflow_doctor = defineTool({
    name: "ralphflow_doctor",
    label: "Ralph Flow: Doctor",
    description: "Diagnose all workflow definitions and skills (project + global + built-in): validation errors with full reason lists, silently-skipped steps, unreachable steps, unresolvable template tokens, broken sub-workflow references and cycles, shadowing, ignored non-workflow YAML files, and corrupt instance state. Read-only.",
    parameters: Type.Object({}),
    execute: async () => {
      const index = loadSkillIndex(engine.getRalphFlowDir(), engine.getGlobalConfigHome());
      return text(`${engine.buildDoctorReport()}\n\n## Skill\n\n${formatSkillReport(index)}`);
    },
  }) as unknown as ToolDefinition;

  return [ralphflow_start, ralphflow_continue, ralphflow_watch, ralphflow_cancel, ralphflow_status, ralphflow_list, ralphflow_doctor];
}
