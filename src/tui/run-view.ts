/**
 * The run view — a full-screen pi-tui app that shows one workflow running.
 *
 * This is the payoff of Direction A. No supervisor LLM sits between the user and
 * the engine: the runner drives the workflow autonomously, its structured events
 * feed the pure run-model, and this file renders that model and turns keystrokes
 * into engine actions. The only AI sessions are the ones actually doing the work
 * (each DO step) and judging it (each CHECK) — and you watch them live.
 *
 * The interaction model is one persistent input, always available except during
 * CHECK (read-only by design) and once the run has ended. There is no separate
 * modal hotkey layer for gates/pauses — that would be a second interaction
 * language bolted onto the first, and the whole point of this view is to feel
 * like talking to the work the way you would in Claude Code or opencode: plain
 * text always talks to the work (steer the live DO session / revise a gate /
 * leave a note for the next retry), `/`-commands always control the state
 * machine (`/ralphflow-continue`, `/ralphflow-cancel` — the same names the chat
 * surface already uses for the same actions, see commands/prompts.ts).
 *
 * All the visual logic is in render.ts (pure, fully tested). This file is the
 * thin pi-tui shell: a Component that emits render.ts's lines, plus the input
 * box and the dispatcher that turns submitted text into engine actions.
 */

import type { RunModel } from "./run-model.js";
import { isTerminal } from "./run-model.js";
import { renderScreen } from "./render.js";
import { Component, Input, TUI, matchesKey, Key, getSelectListTheme } from "../pi/tui.js";

export interface RunViewActions {
  /** Approve a manual gate → continue to verification. */
  approveGate(): void;
  /** Ask for changes at a manual gate, with the user's instruction. */
  reviseGate(instruction: string): void;
  /** Resume a paused/stalled workflow after the user fixed things. */
  resume(): void;
  /** Cancel the workflow. */
  cancel(): void;
  /** Steer a plain-text message into the currently active DO session. */
  sendMessage(text: string): void;
  /** Leave a note for the next retry while paused/stalled — doesn't resume by itself. */
  attachNote(text: string): void;
}

/** A Component that renders the run model; `scrollBack` is owned by the view. */
class ScreenComponent implements Component {
  scrollBack = 0;
  constructor(private readonly model: () => RunModel) {}
  render(width: number): string[] {
    return renderScreen(this.model(), width, this.scrollBack);
  }
  invalidate(): void {}
}

/** Whether the persistent input should be mounted for the current model state. */
function inputActive(m: RunModel): boolean {
  return m.activePhase !== "check" && !isTerminal(m);
}

function isCommand(text: string, names: string[]): boolean {
  const head = text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return names.includes(head);
}

/**
 * The single dispatch rule for whatever the user submits. Pure function of
 * (text, model) → an action call, so it's unit-testable without a terminal.
 */
export function dispatchInput(rawText: string, m: RunModel, actions: RunViewActions): void {
  const text = rawText.trim();
  if (!text) return;

  if (isCommand(text, ["/ralphflow-continue", "/continue"])) {
    if (m.status === "gate") actions.approveGate();
    else if (m.status === "paused" || m.status === "stalled") actions.resume();
    return;
  }
  if (isCommand(text, ["/ralphflow-cancel", "/cancel"])) {
    if (m.status !== "completed" && m.status !== "cancelled") actions.cancel();
    return;
  }
  if (text.startsWith("/")) return; // unrecognized command — ignore rather than misfire

  if (m.status === "running" && m.activePhase === "do") { actions.sendMessage(text); return; }
  if (m.status === "gate") { actions.reviseGate(text); return; }
  if (m.status === "paused" || m.status === "stalled") { actions.attachNote(text); return; }
  // running+check, completed, cancelled: no input is mounted for these states
  // in practice (see inputActive), but stay a no-op if reached anyway.
}

/**
 * Run the full-screen view for one instance until it finishes or the user quits.
 * Resolves when the TUI is torn down. `getModel` returns the live model that the
 * caller mutates from runner events; call `requestRender()` after each mutation.
 */
export function createRunView(opts: {
  tui: TUI;
  getModel(): RunModel;
  actions: RunViewActions;
  /** Called when the user chooses to quit (Esc on an empty input). */
  onQuit(): void;
}): { screen: ScreenComponent; stepInput: Input; requestRender(): void; handleInput(data: string): boolean } {
  const { tui, getModel, actions, onQuit } = opts;
  const screen = new ScreenComponent(getModel);
  const stepInput = new Input();
  let inputMounted = false;

  stepInput.onSubmit = (value: string) => {
    const text = value.trim();
    stepInput.setValue("");
    if (text) dispatchInput(text, getModel(), actions);
    requestRender();
  };

  /** Mount/focus the input exactly when the current state accepts it. */
  function syncInput(): void {
    const active = inputActive(getModel());
    if (active && !inputMounted) {
      tui.addChild(stepInput);
      tui.setFocus(stepInput);
      inputMounted = true;
    } else if (!active && inputMounted) {
      tui.removeChild(stepInput);
      tui.setFocus(null);
      inputMounted = false;
    }
  }

  function requestRender(): void {
    syncInput();
    tui.requestRender();
  }

  /**
   * Global keys — scrolling and quit only. Everything else (typed text, Enter,
   * cursor movement within the box) is NOT handled here: when this returns
   * false, pi-tui forwards the raw input to the focused component itself
   * (stepInput, via tui.setFocus in syncInput), which is where actual typing
   * belongs. Returns true if handled here.
   */
  function handleInput(data: string): boolean {
    if (tui.hasOverlay()) return false;

    if (matchesKey(data, Key.up)) { screen.scrollBack += 1; requestRender(); return true; }
    if (matchesKey(data, Key.down)) { screen.scrollBack = Math.max(0, screen.scrollBack - 1); requestRender(); return true; }
    if (matchesKey(data, Key.pageUp)) { screen.scrollBack += 10; requestRender(); return true; }
    if (matchesKey(data, Key.pageDown)) { screen.scrollBack = Math.max(0, screen.scrollBack - 10); requestRender(); return true; }

    if (matchesKey(data, Key.escape)) {
      // First Esc clears a draft in progress (cheap to hit by accident while
      // typing); only an Esc on an empty box actually quits.
      if (stepInput.getValue().trim().length > 0) { stepInput.setValue(""); requestRender(); return true; }
      onQuit();
      return true;
    }

    return false;
  }

  return { screen, stepInput, requestRender, handleInput };
}

// getSelectListTheme is imported so the launcher (which shares this module's pi
// surface) can theme its picker without importing pi-tui directly.
export { getSelectListTheme };
