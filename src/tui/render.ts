/**
 * Pure rendering: RunModel → terminal lines.
 *
 * No pi-tui, no side effects, no I/O. Given a model and a width it returns the
 * exact lines the run view shows, so the entire look of the product is unit-
 * testable without a terminal. run-view.ts is a thin pi-tui wrapper that pipes
 * these lines to the screen and calls back in on input.
 *
 * The layout is a growing stream on top with a persistent status block pinned at
 * the bottom (pi-tui's TUI keeps the tail visible, so "bottom" is always on
 * screen while stream history scrolls up — the same shape as a chat's fixed
 * input bar). This is what a chat transcript could never give: a live pipeline
 * you can see all of, with each step's real work streaming in place.
 */

import {
  isTerminal, needsUser,
  type RunModel, type RunStatus, type StepStatus, type StepView, type StreamBlock,
} from "./run-model.js";
import { visibleWidth, wrapTextWithAnsi, truncateToWidth } from "../pi/tui.js";

// ─── minimal ANSI (kept local so this file stays pure and dependency-free) ────

const ESC = "\x1b[";
const codes = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};
const c = (code: string, s: string) => `${code}${s}${codes.reset}`;
export const dim = (s: string) => c(codes.dim, s);
export const bold = (s: string) => c(codes.bold, s);
export const green = (s: string) => c(codes.green, s);
export const red = (s: string) => c(codes.red, s);
export const yellow = (s: string) => c(codes.yellow, s);
export const cyan = (s: string) => c(codes.cyan, s);
export const gray = (s: string) => c(codes.gray, s);
export const magenta = (s: string) => c(codes.magenta, s);

/**
 * Display width, counting CJK/emoji as 2 columns (delegates to pi-tui so it
 * agrees exactly with the width pi-tui's renderer enforces — a mismatch makes
 * the TUI throw "line exceeds terminal width").
 */
export function visibleLength(s: string): number {
  return visibleWidth(s);
}

/**
 * Wrap a logical line to `width` display columns, ANSI- and wide-char-aware.
 * Uses pi-tui's own wrapper, so every line we emit is guaranteed to fit.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(raw, width);
    if (wrapped.length === 0) out.push("");
    else for (const l of wrapped) out.push(l);
  }
  return out;
}

// ─── step list (the compact pipeline row that stays visible) ──────────────────

const STEP_ICON: Record<StepStatus, string> = {
  pending: gray("○"),
  do: cyan("▶"),
  check: yellow("🔍"),
  passed: green("✓"),
  failed: red("✗"),
  gate: magenta("📋"),
  done: green("✓"),
};

function stepIcon(status: StepStatus): string {
  return STEP_ICON[status] ?? gray("○");
}

/**
 * Pipeline strip: an icon-only progress row, then a dedicated line naming
 * the active step — number, description, DO/CHECK, elapsed. Two lines, not
 * one, on purpose: cramming "步骤 3/7：技术方案设计 DO 45s" onto the same
 * line as the icon row (the original design) made a user report they could
 * only tell "some step is running" from a glance — the icons read fine as a
 * progress bar, but the one piece of text answering "which step, doing
 * what, DO or CHECK" was easy to miss appended after seven icons. Giving it
 * its own line, led with the step's ordinal position, fixes that without
 * adding new information — everything here was already computed, just
 * under-emphasized. `now` defaults to the real clock but is an explicit
 * param so tests stay deterministic — this is the only place render.ts
 * touches wall-clock time at all.
 */
export function renderStepStrip(m: RunModel, width: number, now: number = Date.now()): string[] {
  const icons = m.steps.map((s) => (s.id === m.activeStepId ? bold(stepIcon(s.status)) : stepIcon(s.status))).join(" ");
  const active = m.steps.find((s) => s.id === m.activeStepId);
  const out = wrap(icons, width);
  if (active) out.push(...wrap(activeLabel(m, active, now), width));
  return out;
}

function activeLabel(m: RunModel, step: StepView, now: number): string {
  const ordinal = m.steps.findIndex((s) => s.id === step.id) + 1;
  const stepNum = bold(`步骤 ${ordinal}/${m.steps.length}`);
  const phaseTag = m.activePhase === "do" ? cyan("DO") : m.activePhase === "check" ? yellow("CHECK") : "";
  const elapsed = m.activePhase && m.phaseStartedAt ? dim(` ${formatElapsed(now - m.phaseStartedAt)}`) : "";
  return `${stepNum}${dim("：")}${step.desc}${phaseTag ? " " + phaseTag : ""}${elapsed}`;
}

/**
 * "3m05s" / "42s" — the only way to tell "still thinking" from "stuck" during
 * a long silent stretch (no reasoning/tool events at all) is a ticking clock,
 * not the stream itself.
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

// ─── the stream (the active step's live work) ─────────────────────────────────

/** Render one block. Reasoning is dimmed; tools show their key arg + a few result lines. */
export function renderBlock(b: StreamBlock, width: number): string[] {
  switch (b.kind) {
    case "phase":
      return [dim("─".repeat(Math.min(width, 40))), ...wrap(bold(b.phase === "do" ? `▶ DO${b.attempt > 1 ? ` · 第 ${b.attempt} 次` : ""}` : `🔍 CHECK（独立只读验证）`), width)];
    case "reasoning": {
      const lines = wrap(b.text.trim(), width);
      return lines.map((l) => dim(l));
    }
    case "text":
      return wrap(b.text.trim(), width);
    case "tool": {
      const lines = wrap(toolHead(b), width);
      if (b.result && b.result.trim()) {
        const resultLines = wrap(b.result.trim(), Math.max(1, width - 2)).slice(0, 12);
        for (const rl of resultLines) lines.push("  " + dim(rl));
      }
      return lines;
    }
    case "verdict": {
      if (b.infra) return [yellow(`⚠ 验证未能运行：${b.reason}`)];
      const head = b.passed ? green(`✓ 通过`) : red(`✗ 未通过`);
      return wrap(`${head} ${dim("— " + b.reason)}`, width);
    }
    case "notice":
      return wrap(b.text, width);
    case "user":
      return wrap(bold(cyan("› 你：")) + " " + b.text, width);
  }
}

function toolHead(b: Extract<StreamBlock, { kind: "tool" }>): string {
  const mark = b.status === "running" ? cyan("▸") : b.status === "error" ? red("✗") : green("▸");
  const arg = b.arg ? " " + dim(b.arg) : "";
  return `${mark} ${b.name}${arg}`;
}

/** The active step's stream as lines. */
export function renderStream(m: RunModel, width: number): string[] {
  const blocks = m.activeStepId ? m.streams.get(m.activeStepId) ?? [] : [];
  const out: string[] = [];
  for (const b of blocks) {
    for (const line of renderBlock(b, width)) out.push(line);
  }
  return out;
}

// ─── the persistent status block (pinned at the bottom) ───────────────────────

const STATUS_HEAD: Record<RunStatus, string> = {
  running: cyan("▶ 运行中"),
  gate: magenta("📋 等待审查"),
  paused: yellow("⏸ 已暂停"),
  stalled: yellow("⚠ 已停止驱动"),
  completed: green("✓ 已完成"),
  cancelled: gray("已取消"),
};

/** Header + step strip + action prompt + hints — always visible at the bottom. */
export function renderStatus(m: RunModel, width: number, now: number = Date.now()): string[] {
  const out: string[] = [];
  out.push(dim("─".repeat(width)));
  // Title line: workflow · task.
  const title = `${bold(m.workflowName)}${dim(" · ")}${truncate(m.task, Math.max(10, width - visibleLength(m.workflowName) - 4))}`;
  out.push(...wrap(title, width));
  // Pipeline strip (icons, then "步骤 N/Total：desc DO/CHECK elapsed" — the
  // step counter lives there now, right next to what it's counting; restating
  // it here would just be the same number twice).
  out.push(...renderStepStrip(m, width, now));
  // Run status (running / gate / paused / stalled / completed / cancelled).
  out.push(...wrap(STATUS_HEAD[m.status], width));
  // Action prompt when the user is needed.
  for (const line of renderAction(m, width)) out.push(line);
  // Key hints.
  out.push(...wrap(dim(hintLine(m)), width));
  return out;
}

/** The actionable block for gate / pause / stall / completion. */
export function renderAction(m: RunModel, width: number): string[] {
  if (m.status === "gate") {
    return [
      ...wrap(magenta("📋 ") + m.statusDetail, width),
      ...wrap(`直接打字提修改意见，或输入 ${bold("/ralphflow-continue")} 通过、${bold("/ralphflow-cancel")} 取消`, width),
    ];
  }
  if (m.status === "paused" || m.status === "stalled") {
    return [
      ...wrap(yellow("⏸ ") + m.statusDetail, width),
      ...wrap(`可以先打字留一句补充说明，再输入 ${bold("/ralphflow-continue")} 继续、${bold("/ralphflow-cancel")} 取消`, width),
    ];
  }
  if (m.status === "completed") {
    const rp = m.reportPath ? dim(`报告：${m.reportPath}`) : "";
    return wrap(green("✓ 工作流完成。") + (rp ? " " + rp : ""), width);
  }
  return [];
}

function hintLine(m: RunModel): string {
  if (isTerminal(m)) return "Esc 退出 · ↑↓ 滚动";
  if (m.activePhase === "check") return "🔍 独立验证中，不可插话 · ↑↓ 滚动 · Esc 退出";
  if (needsUser(m)) return "↑↓ 滚动 · Esc 退出（输入框为空时）";
  return "随时打字插话，模型会接着聊 · ↑↓ 滚动 · Esc 退出（输入框为空时）";
}

// ─── whole screen (stream on top, status pinned below) ────────────────────────

/**
 * The complete document. pi-tui's `TUI` has no real scrollable viewport —
 * there's no API for "pin this footer, scroll that region above it" (checked:
 * `TUI extends Container`'s public surface has nothing scroll-related; the
 * `previousViewportTop` field it does have is a private diffing internal, not
 * something a Component can use). What `TUI` actually does is redraw the last
 * `terminalRows` lines of *whatever this function returns this frame* — so
 * "scrolling" only has one degree of freedom available: change how many lines
 * this function returns, in front of a renderer that always anchors to the
 * bottom of that array.
 *
 * The bug this used to have: the earlier version dropped lines straight off
 * the end of `stream` as `scrollBack` grew, which shrinks the *whole returned
 * array* by that much every keypress — since the status block sits at the very
 * end, its position relative to the top of the (now shorter) array moves every
 * time, and because the renderer bottom-anchors, that reads as the status
 * block itself sliding up the screen the moment you press Up, before there's
 * any real "scrolling" sensation at all. A user reported exactly this: "方向键
 * 上去看的时候，不是滚动看，而是下面分割线的布局先往上跑."
 *
 * The fix: keep the returned array's total length **invariant to
 * `scrollBack`** by left-padding with blank lines instead of shrinking the
 * array. The status block then always sits at the same offset from the end of
 * the document no matter how far back you've scrolled, so the bottom-anchored
 * renderer keeps it visually still — only the *content* revealed above it
 * changes as you page up, which is what "scrolling" is supposed to look like
 * within a renderer that has no actual scroll primitive.
 */
export function renderScreen(m: RunModel, width: number, scrollBack = 0, now: number = Date.now()): string[] {
  const stream = renderStream(m, width);
  const status = renderStatus(m, width, now);
  const visibleCount = Math.max(0, stream.length - scrollBack);
  const revealed = stream.slice(0, visibleCount);
  const padding = new Array(stream.length - revealed.length).fill("");
  return [...padding, ...revealed, "", ...status];
}

function truncate(s: string, width: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return visibleWidth(clean) <= width ? clean : truncateToWidth(clean, Math.max(1, width));
}
