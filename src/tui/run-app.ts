/**
 * The dedicated run view: renders one workflow instance running, live.
 *
 * `runInstanceInTui` is the reusable core — given an existing engine/runner
 * and a TUI to render into, it drives one instance to completion/cancellation
 * or until the user detaches, translating keystrokes into engine actions
 * (approve / revise / resume / cancel / steer). The runner drives the
 * workflow autonomously; this file just shows it and steers it. No LLM sits
 * in the loop.
 *
 * Two callers:
 *  - `runApp(cwd)`: the standalone CLI path (own process, own TUI, own
 *    launcher to pick a workflow). Kept for direct invocation; no longer the
 *    default `ralphflow` entry point (see cli.ts) — that's now the chat.
 *  - `attachRunView` (tui/embed.ts): the chat session hands this its OWN
 *    already-running TUI/engine/runner via `ctx.ui.custom()`, so starting a
 *    workflow from chat takes over the SAME terminal instead of a second one.
 */

import fs from "fs";
import type { Engine } from "../engine/core.js";
import { createEngine } from "../engine/core.js";
import { abortActiveCheck } from "../engine/check.js";
import { createRunner, type Runner, type RunnerEvents } from "../engine/runner.js";
import { withInstanceLock, isInstanceGone } from "../engine/lock.js";
import { loadSkillIndex } from "../engine/skills.js";
import { isSubWorkflowStep, type RalphFlowState, type WorkflowDef } from "../engine/types.js";
import {
  applyCancelled, applyCompleted, applyGate, applyPaused, applyReplayNotice, applyStalled,
  applyStepEvent, applyStepStart, applyUserMessage, applyVerdict, initRunModel, primeForAttach, type RunModel,
} from "./run-model.js";
import { runLauncher, type LaunchChoice } from "./launcher.js";
import { createRunView } from "./run-view.js";
import { TUI, ProcessTerminal, initTheme } from "../pi/tui.js";
import { replaySessionEvents, truncateReplayEvents } from "../pi/adapter.js";

/** A stable owner token for this process's run. */
function makeSessionId(): string {
  return `ralphflow-run-${process.pid}-${Date.now().toString(36)}`;
}

/**
 * Terminal bell (BEL, \x07) on every state a human might need to come back
 * for: gate, paused, stalled, completed. Cheapest possible "come look" signal
 * that works identically whether the run view is the whole process (runApp)
 * or a chat session's borrowed terminal (attachRunView) — most terminals/
 * terminal multiplexers turn this into a visible tab/window flash or an
 * audible ding even when the pane isn't focused, which a rendered line never
 * achieves on its own. No config flag: this fires at most once per state
 * transition (called from the same event handler that already renders once),
 * never in a loop, so there is no plausible "too noisy" failure mode to gate.
 */
function bell(): void {
  try { process.stdout.write("\x07"); } catch {}
}

export async function runApp(cwd: string): Promise<void> {
  initTheme();
  const engine = createEngine(cwd, { abortActiveCheck });
  engine.ensureProjectWorkflows();
  const sessionId = makeSessionId();

  const tui = new TUI(new ProcessTerminal());
  tui.start();

  const runner = createRunner(engine, {}, {
    skillPaths: () => loadSkillIndex(engine.getRalphFlowDir(), engine.getGlobalConfigHome()).paths,
  });
  engine.setAbortActiveStep?.(runner.abortActiveStep);

  // Park interrupted instances on the way out so a restart resumes cleanly.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { runner.pauseAllForShutdown(); } catch {}
    try { tui.stop(); } catch {}
  };
  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });

  try {
    const choice = await runLauncher(tui, engine);
    if (choice.kind === "quit") return;

    const instId = choice.kind === "resume"
      ? choice.instanceId!
      : createInstance(engine, choice.workflow!, choice.task!, sessionId);

    if (!instId) return; // creation failed (surfaced by createInstance)

    await runInstanceInTui({ engine, tui, sessionId, instId, runner });
  } finally {
    shutdown();
  }
}

/**
 * Create a fresh instance owned by this session and cache its first DO prompt.
 * Mirrors ralphflow_start's creation path (normal or sub-workflow first step),
 * minus the chat-surface text and auto-run — the run app drives it itself.
 */
function createInstance(engine: Engine, workflow: string, task: string, sessionId: string): string | null {
  const wf = engine.loadWorkflow(workflow);
  if (!wf || wf.steps.length === 0) return null;
  const firstStep = wf.steps[0];

  const instId = engine.generateInstanceId(workflow);
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, task);
  const baseState: RalphFlowState = {
    active: true, workflow_name: workflow, current_step: firstStep.id, current_phase: "do",
    fail_count: 0, user_task: task, paused: false, session_id: sessionId,
  };
  engine.writeState(baseState, instId);
  engine.recordStepStart(instId, firstStep.id, "do");
  engine.logEvent(instId, "info", "workflow_start", { workflow, instance: instId });

  if (isSubWorkflowStep(firstStep)) {
    engine.pushState(baseState, instId);
    const sub = engine.resolveSubWorkflowEntry(instId, firstStep.workflow, task, firstStep);
    if (sub.error) {
      try { fs.rmSync(engine.getInstanceDir(instId), { recursive: true, force: true }); } catch {}
      return null;
    }
  } else {
    if (wf.manual_step.includes(firstStep.id)) engine.writeManualStepMarker(instId);
    engine.buildDoPrompt(instId, firstStep, task);
  }
  return instId;
}

export interface RunInstanceOutcome {
  /**
   * "completed"/"cancelled" mirror the instance's terminal fate. "detached"
   * means the user left the run view (Esc on an empty input) while the
   * workflow was still gate/paused/stalled/running — the runner keeps
   * driving it untouched; nothing here pauses or aborts anything on detach.
   */
  outcome: "completed" | "cancelled" | "detached";
  reportPath?: string;
}

/**
 * Drive one instance to its end (or the user detaching), rendering it live
 * into `tui`. Does not own `engine`/`runner`/`sessionId`/`tui` — the caller
 * decides their lifetime, which is what lets this run against either a
 * process's own dedicated TUI (`runApp`) or a chat session's TUI borrowed via
 * `ctx.ui.custom()` (`attachRunView`).
 */
export function runInstanceInTui(opts: {
  engine: Engine;
  tui: TUI;
  sessionId: string;
  instId: string;
  runner: Runner;
}): Promise<RunInstanceOutcome> {
  const { engine, tui, sessionId, instId, runner } = opts;
  return new Promise<RunInstanceOutcome>((resolve) => {
    const workflow = engine.loadWorkflow(engine.readState(instId)!.workflow_name)!;
    const model: RunModel = buildInitialModel(engine, instId, workflow);
    // Reassigned to view.requestRender once the view exists (it also syncs the
    // persistent input's mount/focus state — see run-view.ts).
    let render = () => tui.requestRender();
    /** Text left at a paused/stalled state via attachNote, consumed on resume. */
    const pendingResumeNotes = new Map<string, string>();

    let removeInputListener: (() => void) | null = null;
    let removeRunnerListener: (() => void) | null = null;
    // Everything else re-renders reactively off runner events, but elapsed
    // time needs a clock tick even during a long silent stretch (the model
    // reasoning with no tool calls at all) — otherwise the timer freezes and
    // looks exactly like the stuck-vs-thinking ambiguity it exists to solve.
    // Cheap to over-fire: renderStepStrip only shows elapsed while a phase is
    // active, and pi-tui's differential renderer no-ops an unchanged frame.
    const tickTimer = setInterval(() => { if (model.activePhase) render(); }, 1000);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(tickTimer);
      removeInputListener?.();
      removeRunnerListener?.();
      resolve({
        outcome: model.status === "completed" ? "completed" : model.status === "cancelled" ? "cancelled" : "detached",
        reportPath: model.reportPath,
      });
    };

    // Structured events → the pure model → a render request. No parsing, no LLM.
    //
    // `runner.addEventListener` is a single shared broadcast bus — the SAME
    // runner now commonly drives several instances at once (boot-time
    // adoption of leftover instances, and a session deliberately running more
    // than one workflow — see tools.ts's ralphflow_start), so every listener
    // receives every instance's events, not just this view's. Each handler
    // MUST check `i === instId` before touching `model`: without it, another
    // instance's DO/CHECK stream gets applied straight into this one's model
    // — its reasoning text bleeding into this view, its onStepStart even
    // hijacking `model.activeStepId` outright. Purely a display bug (these
    // reducers only ever mutate the local `model`, never engine/fs state), but
    // a real one — confirmed via a live repro: watch instance B while
    // instance A is still running in the background, and A's thinking text
    // shows up in B's view.
    const events: RunnerEvents = {
      onStepStart: (i, sid, phase, attempt) => { if (i !== instId) return; applyStepStart(model, sid, phase, attempt); render(); },
      onStepEvent: (i, sid, phase, e) => { if (i !== instId) return; applyStepEvent(model, sid, phase, e); render(); },
      onVerdict: (i, sid, r) => { if (i !== instId) return; applyVerdict(model, sid, r); render(); },
      onGate: (i, sid) => { if (i !== instId) return; applyGate(model, sid); render(); bell(); },
      onPaused: (i, st) => { if (i !== instId) return; applyPaused(model, st); render(); bell(); },
      onStalled: (i, sid, a) => { if (i !== instId) return; applyStalled(model, sid, a); render(); bell(); },
      onCompleted: (i, rp) => { if (i !== instId) return; applyCompleted(model, rp); render(); bell(); },
    };
    removeRunnerListener = runner.addEventListener(events);

    const view = createRunView({
      tui,
      getModel: () => model,
      onQuit: finish,
      actions: {
        approveGate: () => { void continueInstance(engine, runner, sessionId, instId); },
        reviseGate: (instruction) => runner.reviseGate(instId, instruction),
        resume: () => {
          const note = pendingResumeNotes.get(instId);
          pendingResumeNotes.delete(instId);
          void continueInstance(engine, runner, sessionId, instId, note);
        },
        cancel: () => { void cancelInstance(engine, runner, instId).then(() => { applyCancelled(model); render(); finish(); }); },
        sendMessage: (text) => {
          // Optimistic local echo — same style as the other actions here, no
          // need to round-trip through a RunnerEvents callback for this.
          const sid = model.activeStepId;
          if (sid && model.activePhase === "do") { applyUserMessage(model, sid, text); render(); }
          runner.sendUserMessage(instId, text);
        },
        attachNote: (text) => {
          const note = text.trim();
          if (!note) return;
          pendingResumeNotes.set(instId, note);
          const sid = model.activeStepId;
          if (sid) { applyUserMessage(model, sid, note); render(); }
        },
      },
    });
    render = view.requestRender;

    // Put the view on screen and route keys to it.
    tui.clear();
    tui.addChild(view.screen);
    render();
    removeInputListener = tui.addInputListener((data) => (view.handleInput(data) ? { consume: true } : undefined));

    // Kick off the run.
    runner.ensureRunning(instId);
  });
}

/** Build the initial model, reflecting a resumed instance's current position. */
function buildInitialModel(engine: Engine, instId: string, workflow: WorkflowDef): RunModel {
  const state = engine.readState(instId)!;
  const model = initRunModel(instId, workflow, state.user_task);
  // Reflect where the instance actually is — this view may be attaching to
  // one that's already running (ralphflow_watch, or ralphflow_continue
  // landing back in the view), not one it just launched itself. See
  // primeForAttach's own doc comment for why this is safe to call
  // unconditionally, including for a genuinely fresh start.
  const passedStepIds = [...new Set(
    engine.loadStepRecords(instId).filter((r) => r.phase === "check" && r.status === "passed").map((r) => r.stepId),
  )];
  primeForAttach(model, state, passedStepIds);
  if (state.paused) {
    applyPaused(model, state); // overrides activePhase back to null; keeps activeStepId/done-steps from above
  }
  replayCurrentStepHistory(engine, model, instId, state);
  return model;
}

/**
 * Backfill the active step's stream from its persisted transcript. Without
 * this, primeForAttach alone leaves `streams` empty on every fresh attach
 * (see its own doc comment) — the view shows nothing from before this attach
 * until the next live runner event happens to arrive, even though everything
 * that already happened is sitting on disk in the step's session dir.
 *
 * Only the DO phase is replayable: CHECK sessions are never given a
 * `sessionDir` (check.ts calls them "disposable" — the verdict is what
 * survives, not the transcript), so `listStepSessionDirs(..., "check")` is
 * always empty and this is a no-op for an in-progress CHECK, same as today.
 */
function replayCurrentStepHistory(engine: Engine, model: RunModel, instId: string, state: RalphFlowState): void {
  const stepId = state.current_step;
  const phase = state.current_phase;
  if (!stepId || phase !== "do") return;
  const dirs = engine.listStepSessionDirs(instId, stepId, phase);
  const dir = dirs[dirs.length - 1];
  if (!dir) return;
  const { events, omitted } = truncateReplayEvents(replaySessionEvents(dir));
  if (omitted > 0) {
    applyReplayNotice(model, stepId, `…已省略 ${omitted} 条更早记录，完整会话见 ${dir}`);
  }
  for (const event of events) applyStepEvent(model, stepId, phase, event);
}

/** Fold an attachNote'd note into whatever failure reason a resume already carries. */
export function combineReason(prevReason: string | undefined, note: string | undefined): string | undefined {
  if (!note) return prevReason;
  return prevReason ? `${prevReason}\n\n用户补充说明：\n${note}` : `用户补充说明：\n${note}`;
}

/** Approve a gate / resume a pause or stall — the ralphflow_continue branches, run-view side. */
async function continueInstance(engine: Engine, runner: Runner, sessionId: string, instId: string, note?: string): Promise<void> {
  try {
    await withInstanceLock(engine.getInstanceDir(instId), instId, () => {
      const state = engine.readState(instId);
      if (!state || !state.active) return;
      engine.bindInstance(instId, sessionId);

      // check_error pause → reset to check, re-verify.
      if (state.paused && state.pause_reason === "check_error" && state.current_phase === "check") {
        engine.writeState({ ...state, paused: false, pause_reason: undefined }, instId);
        return;
      }
      // manual gate → clearing it IS the approval.
      if (engine.markerExists(".manual-gate", instId)) {
        engine.clearManualStepMarker(instId);
        engine.clearManualGate(instId);
        return;
      }
      // other pause → reset fail count, re-issue the DO prompt for a fresh attempt.
      if (state.paused) {
        const prevReason = combineReason(state.last_failure_reason, note);
        const prevFail = state.fail_count;
        engine.clearReinjectCounter(instId);
        engine.clearDoneReported(instId);
        engine.writeState({ ...state, current_phase: "do", paused: false, pause_reason: undefined, fail_count: 0 }, instId);
        const step = engine.getStep(engine.loadWorkflow(state.workflow_name)!, state.current_step);
        if (step && !isSubWorkflowStep(step)) engine.buildDoPrompt(instId, step, state.user_task, prevReason, prevFail);
        return;
      }
      // stalled → the keep-alive budget ran out and the loop exited on its own
      // WITHOUT pausing the state (runner.ts: "the workflow is fine, the model
      // is just stuck"), so none of the branches above fire for it. Rearm the
      // budget explicitly, and fold in a note the same way a real retry would.
      if (state.current_phase === "do" && !runner.isRunning(instId)) {
        engine.clearReinjectCounter(instId);
        if (note) {
          const step = engine.getStep(engine.loadWorkflow(state.workflow_name)!, state.current_step);
          if (step && !isSubWorkflowStep(step)) {
            engine.clearDoPromptCache(instId);
            engine.buildDoPrompt(instId, step, state.user_task, note, state.fail_count || undefined);
          }
        }
      }
    });
  } catch (e) {
    if (!isInstanceGone(e)) throw e;
  }
  if (engine.instanceExists(instId)) runner.ensureRunning(instId);
}

async function cancelInstance(engine: Engine, runner: Runner, instId: string): Promise<void> {
  try {
    await withInstanceLock(engine.getInstanceDir(instId), instId, () => {
      runner.abortActiveStep(instId);
      engine.destroyInstance(instId, "cancelled");
    });
  } catch (e) {
    if (!isInstanceGone(e)) throw e;
  }
}
