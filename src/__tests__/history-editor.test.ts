/**
 * HistoryEditor — completes pi's own half-wired Up/Down input history feature
 * (see the file header on history-editor.ts for why the obvious hook points
 * — overriding `submitValue`, wrapping `onSubmit` — don't work, and why
 * `handleInput` is the one that does). This is a real regression risk: it
 * touches the same editor used for every chat message, so it's exercised
 * against the actual pi-tui `Editor`/`CustomEditor` classes and real
 * keybindings, not a hand-rolled stub of the key-matching logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getKeybindings, type EditorTheme } from "@earendil-works/pi-tui";
import { createFakeTerminal } from "./fake-terminal.js";
import { TUI } from "../pi/tui.js";
import { HistoryEditor, createHistoryEditorFactory } from "../tui/history-editor.js";

const FAKE_THEME: EditorTheme = { borderColor: (s: string) => s, selectList: {} as EditorTheme["selectList"] };
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

let tmpDir: string;
let ralphFlowDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-history-test-"));
  ralphFlowDir = path.join(tmpDir, ".ralph-flow");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A fresh editor over a scratch `.ralph-flow/` dir — no cross-session history unless noted. */
function makeEditor(dir: string = ralphFlowDir): HistoryEditor {
  const tui = new TUI(createFakeTerminal());
  const kb = getKeybindings();
  return createHistoryEditorFactory(dir)(tui, FAKE_THEME, kb);
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

describe("HistoryEditor cross-session persistence", () => {
  it("recalls prompts submitted in an earlier process (same project dir), not just this one", () => {
    const first = makeEditor();
    typeAndSubmit(first, "earlier session's message");

    // A brand new editor over the SAME dir — nothing typed yet this time.
    const second = makeEditor();
    second.handleInput(UP);
    expect(second.getText()).toBe("earlier session's message");
  });

  it("orders persisted entries oldest-to-newest, so the newest is recalled first", () => {
    const first = makeEditor();
    typeAndSubmit(first, "one");
    typeAndSubmit(first, "two");
    typeAndSubmit(first, "three");

    const second = makeEditor();
    second.handleInput(UP);
    expect(second.getText()).toBe("three");
    second.handleInput(UP);
    expect(second.getText()).toBe("two");
    second.handleInput(UP);
    expect(second.getText()).toBe("one");
  });

  it("continues the same history across a third session too — not just a one-hop carryover", () => {
    const first = makeEditor();
    typeAndSubmit(first, "session one");

    const second = makeEditor();
    typeAndSubmit(second, "session two");

    const third = makeEditor();
    third.handleInput(UP);
    expect(third.getText()).toBe("session two");
    third.handleInput(UP);
    expect(third.getText()).toBe("session one");
  });

  it("a fresh project dir with no prior history is just empty — Up is a no-op, not an error", () => {
    const editor = makeEditor(path.join(tmpDir, "never-used", ".ralph-flow"));
    editor.handleInput(UP);
    expect(editor.getText()).toBe("");
  });

  it("different project dirs get independent histories", () => {
    const projectA = path.join(tmpDir, "a", ".ralph-flow");
    const projectB = path.join(tmpDir, "b", ".ralph-flow");
    typeAndSubmit(makeEditor(projectA), "only in A");

    const editorB = makeEditor(projectB);
    editorB.handleInput(UP);
    expect(editorB.getText()).toBe(""); // A's history did not leak into B
  });

  it("persists across sessions as JSONL, one prompt per line, surviving an embedded newline", () => {
    const editor = makeEditor();
    for (const ch of "line one\\") editor.handleInput(ch);
    editor.handleInput(ENTER); // -> newline, not submit
    for (const ch of "line two") editor.handleInput(ch);
    editor.handleInput(ENTER); // real submit of "line one\nline two"

    const raw = fs.readFileSync(path.join(ralphFlowDir, "history.jsonl"), "utf8").trim();
    expect(raw.split("\n")).toHaveLength(1);
    expect(JSON.parse(raw)).toBe("line one\nline two");

    const second = makeEditor();
    second.handleInput(UP);
    expect(second.getText()).toBe("line one\nline two");
  });
});
