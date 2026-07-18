/**
 * Completes a feature pi's own chat editor ships half-wired: `Editor` (the
 * base class `CustomEditor` extends, in pi-tui) already implements Up/Down
 * arrow history navigation in full — `history`/`historyIndex`/`navigateHistory`
 * and the key-handling branches that call it are all there, and `addToHistory`
 * is documented "Called after successful submission." Nothing in
 * pi-coding-agent's interactive mode actually calls it, though (verified by
 * grepping the compiled output of all four @earendil-works packages for
 * `addToHistory` — the only hit is the definition itself). So the editor never
 * has anything to navigate to, even though the navigation logic works.
 *
 * The obvious hook points don't work: `submitValue()` (where the base class's
 * own doc comment says addToHistory should be called) is `private` in the
 * .d.ts, so a subclass can't override or call it. `onSubmit` looks like a
 * public callback property to wrap, but the base class declares it as a bare
 * class field (`onSubmit;`, no initializer) — under ES2022 class-field
 * semantics that materializes as an own `[[DefineOwnProperty]]` on every
 * instance during `super()`, which would silently SHADOW a get/set accessor
 * defined in this subclass rather than route through it.
 *
 * What's actually safe: override the public `handleInput(data)` (already
 * overridden once by `CustomEditor` itself, so this is a well-trodden
 * extension point) and replicate the base class's own submit-detection using
 * only its public surface (`getLines`/`getCursor`/`disableSubmit`/
 * `getExpandedText`/`addToHistory` — none of them private). The backslash-
 * before-cursor check mirrors submitValue's own "Shift+Enter workaround"
 * branch exactly, so a `\` + Enter that inserts a newline instead of
 * submitting doesn't pollute history with a half-typed draft.
 *
 * That still leaves a gap `addToHistory` alone can't close: its `history`
 * array (editor.js) is plain in-memory state, wiped on every new process — Up
 * in a brand new session has nothing to recall even from the SAME project
 * directory a moment ago, unlike Claude Code. prompt-history.ts persists
 * submitted prompts to `.ralph-flow/history.jsonl`; the constructor below
 * replays them into `addToHistory` before the user types a single key.
 */

import { CustomEditor, type EditorTheme, type KeybindingsManager, type TUI } from "../pi/tui.js";
import { appendPromptHistory, loadPromptHistory } from "./prompt-history.js";

export class HistoryEditor extends CustomEditor {
  private kb: KeybindingsManager;
  private ralphFlowDir: string;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, ralphFlowDir: string) {
    super(tui, theme, keybindings);
    this.kb = keybindings;
    this.ralphFlowDir = ralphFlowDir;
    // Pre-load prior sessions' prompts so Up/Down already has something to
    // recall from the very first keystroke of a brand new process — see
    // prompt-history.ts's own doc comment for why oldest-first is correct
    // here (addToHistory un-shifts, so the newest ends up recalled first).
    for (const entry of loadPromptHistory(ralphFlowDir)) this.addToHistory(entry);
  }

  override handleInput(data: string): void {
    if (!this.disableSubmit && this.kb.matches(data, "tui.input.submit")) {
      const cursor = this.getCursor();
      const currentLine = this.getLines()[cursor.line] || "";
      const isBackslashContinuation = cursor.col > 0 && currentLine[cursor.col - 1] === "\\";
      if (!isBackslashContinuation) {
        const text = this.getExpandedText().trim();
        if (text) {
          this.addToHistory(text);
          appendPromptHistory(this.ralphFlowDir, text);
        }
      }
    }
    super.handleInput(data);
  }
}

/** Matches Pi's `EditorFactory` shape for `ctx.ui.setEditorComponent(...)`, curried
 *  over the project's `.ralph-flow/` dir the same way welcome-header.ts's
 *  createWelcomeHeaderFactory is curried over its own engine-derived data. */
export function createHistoryEditorFactory(ralphFlowDir: string) {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): HistoryEditor =>
    new HistoryEditor(tui, theme, keybindings, ralphFlowDir);
}
