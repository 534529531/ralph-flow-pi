/**
 * Cross-session prompt history — what HistoryEditor.ts wires Up/Down to
 * within one process was never the whole gap: pi's own `Editor.history` is a
 * plain in-memory array, reset to empty on every new process. Claude Code
 * recalls prior prompts typed in the same project even in a brand new
 * session; ralph-flow-pi didn't, because nothing persisted them.
 *
 * Stored as one JSON string per line under `.ralph-flow/` (project-scoped,
 * same as everything else this tool keeps) rather than plain newline-joined
 * text, because a history entry can itself contain embedded newlines (the
 * backslash-before-Enter multi-line workaround HistoryEditor already
 * preserves) — JSONL sidesteps needing our own escaping scheme.
 */

import fs from "fs";
import path from "path";

const HISTORY_FILENAME = "history.jsonl";

/** Matches pi-tui's own Editor.addToHistory cap (editor.js: `history.length > 100`
 *  pops the oldest) — nothing past this is ever reachable via Up/Down, so
 *  persisting more than this would only waste disk. */
const MAX_ENTRIES = 100;
/** Trim only once the file has drifted this far past MAX_ENTRIES, not on every
 *  single append — an append is one syscall; a trim rewrites the whole file. */
const TRIM_SLACK = 50;

function historyFilePath(ralphFlowDir: string): string {
  return path.join(ralphFlowDir, HISTORY_FILENAME);
}

/**
 * Oldest first. Callers feed this straight into repeated `addToHistory()`
 * calls, which each `unshift` onto the front — so replaying oldest-to-newest
 * leaves the newest entry recalled first on Up, matching normal history feel.
 */
export function loadPromptHistory(ralphFlowDir: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(historyFilePath(ralphFlowDir), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "string" && parsed.trim()) out.push(parsed);
    } catch {
      // A malformed line (partial write, manual edit) loses just itself.
    }
  }
  return out;
}

function maybeTrim(file: string): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return;
  }
  if (lines.length <= MAX_ENTRIES + TRIM_SLACK) return;
  try {
    fs.writeFileSync(file, lines.slice(-MAX_ENTRIES).join("\n") + "\n");
  } catch {
    // best-effort — an untrimmed file just means a slightly bigger read next time
  }
}

/**
 * Appends one submitted prompt. Best-effort: a history write must never be
 * why a message failed to send, so failures here are swallowed rather than
 * thrown (mirrors engine/core.ts's own logEvent).
 */
export function appendPromptHistory(ralphFlowDir: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    fs.mkdirSync(ralphFlowDir, { recursive: true });
    const file = historyFilePath(ralphFlowDir);
    fs.appendFileSync(file, JSON.stringify(trimmed) + "\n");
    maybeTrim(file);
  } catch {
    // best-effort — see doc comment above
  }
}
