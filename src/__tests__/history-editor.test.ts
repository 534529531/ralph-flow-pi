/**
 * HistoryEditor — completes pi's own half-wired Up/Down input history feature
 * (see the file header on history-editor.ts for why the obvious hook points
 * — overriding `submitValue`, wrapping `onSubmit` — don't work, and why
 * `handleInput` is the one that does). This is a real regression risk: it
 * touches the same editor used for every chat message, so it's exercised
 * against the actual pi-tui `Editor`/`CustomEditor` classes and real
 * keybindings, not a hand-rolled stub of the key-matching logic.
 */

import { describe, it, expect } from "vitest";
import { getKeybindings, type EditorTheme } from "@earendil-works/pi-tui";
import { createFakeTerminal } from "./fake-terminal.js";
import { TUI } from "../pi/tui.js";
import { HistoryEditor, historyEditorFactory } from "../tui/history-editor.js";

const FAKE_THEME: EditorTheme = { borderColor: (s: string) => s, selectList: {} as EditorTheme["selectList"] };
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

function makeEditor(): HistoryEditor {
  const tui = new TUI(createFakeTerminal());
  const kb = getKeybindings();
  return historyEditorFactory(tui, FAKE_THEME, kb);
}

/** Types text character by character, then submits with the real Enter binding. */
function typeAndSubmit(editor: HistoryEditor, text: string): void {
  for (const ch of text) editor.handleInput(ch);
  editor.handleInput(ENTER);
}

describe("HistoryEditor", () => {
  it("recalls the previous message on Up after submitting", () => {
    const editor = makeEditor();
    typeAndSubmit(editor, "first message");

    editor.handleInput(UP);
    expect(editor.getText()).toBe("first message");
  });

  it("walks further back through multiple submissions, then Down returns toward the draft", () => {
    const editor = makeEditor();
    typeAndSubmit(editor, "one");
    typeAndSubmit(editor, "two");

    editor.handleInput(UP); // -> "two" (most recent)
    expect(editor.getText()).toBe("two");
    editor.handleInput(UP); // -> "one" (older)
    expect(editor.getText()).toBe("one");

    editor.handleInput(DOWN); // back down -> "two"
    expect(editor.getText()).toBe("two");
    editor.handleInput(DOWN); // back down past the most recent -> empty (not browsing)
    expect(editor.getText()).toBe("");
  });

  it("does not add an empty or whitespace-only submission to history", () => {
    const editor = makeEditor();
    typeAndSubmit(editor, "   ");
    editor.handleInput(UP);
    // Nothing to recall — Up with an empty history is a no-op.
    expect(editor.getText()).toBe("");
  });

  it("does not add a duplicate consecutive entry", () => {
    const editor = makeEditor();
    typeAndSubmit(editor, "same");
    typeAndSubmit(editor, "same");

    editor.handleInput(UP);
    expect(editor.getText()).toBe("same");
    editor.handleInput(UP); // no older duplicate entry to move to
    expect(editor.getText()).toBe("same");
  });

  it("does not submit (or record) on backslash-then-Enter — the Shift+Enter workaround inserts a newline instead", () => {
    const editor = makeEditor();
    for (const ch of "line one\\") editor.handleInput(ch);
    editor.handleInput(ENTER); // backslash before cursor -> newline, not submit
    expect(editor.getText()).toBe("line one\n");

    for (const ch of "line two") editor.handleInput(ch);
    editor.handleInput(ENTER); // now a real submit of the two-line text

    editor.handleInput(UP);
    expect(editor.getText()).toBe("line one\nline two");
  });
});
