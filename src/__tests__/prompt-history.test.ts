/**
 * prompt-history.ts's file-level behavior — load/append round-tripping, and
 * the disk-side trim that keeps `.ralph-flow/history.jsonl` from growing
 * forever. history-editor.test.ts covers the Up/Down-facing behavior this
 * backs; these tests are about the file itself.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { appendPromptHistory, loadPromptHistory } from "../tui/prompt-history.js";

let tmpDir: string;
let ralphFlowDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-prompt-history-test-"));
  ralphFlowDir = path.join(tmpDir, ".ralph-flow");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPromptHistory", () => {
  it("returns an empty list when nothing was ever persisted", () => {
    expect(loadPromptHistory(ralphFlowDir)).toEqual([]);
  });

  it("round-trips entries in the order they were appended (oldest first)", () => {
    appendPromptHistory(ralphFlowDir, "one");
    appendPromptHistory(ralphFlowDir, "two");
    appendPromptHistory(ralphFlowDir, "three");
    expect(loadPromptHistory(ralphFlowDir)).toEqual(["one", "two", "three"]);
  });

  it("ignores a blank/whitespace-only submission", () => {
    appendPromptHistory(ralphFlowDir, "   ");
    expect(loadPromptHistory(ralphFlowDir)).toEqual([]);
  });

  it("skips a malformed line instead of losing the rest of the file", () => {
    fs.mkdirSync(ralphFlowDir, { recursive: true });
    const file = path.join(ralphFlowDir, "history.jsonl");
    fs.writeFileSync(file, `${JSON.stringify("good one")}\nnot valid json\n${JSON.stringify("good two")}\n`);
    expect(loadPromptHistory(ralphFlowDir)).toEqual(["good one", "good two"]);
  });

  it("preserves embedded newlines within a single entry", () => {
    appendPromptHistory(ralphFlowDir, "line one\nline two");
    expect(loadPromptHistory(ralphFlowDir)).toEqual(["line one\nline two"]);
  });
});

describe("disk-side trimming", () => {
  it("keeps the file from growing unboundedly — trims back down once it drifts far enough past the cap", () => {
    for (let i = 0; i < 200; i++) appendPromptHistory(ralphFlowDir, `entry-${i}`);
    const entries = loadPromptHistory(ralphFlowDir);
    // Trimmed to (roughly) the most recent window, not all 200 kept forever.
    expect(entries.length).toBeLessThan(200);
    expect(entries[entries.length - 1]).toBe("entry-199"); // newest always survives
    expect(entries).not.toContain("entry-0"); // oldest was evicted
  });
});
