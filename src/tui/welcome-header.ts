/**
 * Custom startup header — replaces Pi's generic "Pi can explain its own
 * features and look up its docs..." welcome text with a small bordered
 * banner that actually says what ralph-flow-pi is and how to start it, via
 * `ctx.ui.setHeader` (same "session_start" seam `setEditorComponent` uses —
 * see extension.ts and history-editor.ts). `Component` (pi-tui) is a
 * structural interface (`render(width): string[]`), not a base class to
 * extend, so this is a plain object literal — no subclassing, and the
 * content-building part is a pure function, unit-testable without a TUI.
 *
 * The box is hand-rolled rather than reused from pi-tui/pi-coding-agent:
 * `Box` (pi-tui) is padding+background only, no border; `DynamicBorder`
 * (pi-coding-agent) is a single horizontal rule, not a full frame. Every
 * width computation goes through `visibleWidth`/`wrapTextWithAnsi` (both
 * confirmed ANSI-aware AND CJK/emoji-width-aware by a quick node -e check
 * against the real package, not assumed) — the exact pitfall
 * [[pi-sdk-gotchas]]-equivalent lesson from render.ts's own header comment:
 * get this wrong and pi-tui throws "line exceeds terminal width" outright,
 * it doesn't just look a little off.
 */

import { type Component, type Theme } from "../pi/tui.js";
import { visibleWidth, wrapTextWithAnsi } from "../pi/tui.js";

export interface WelcomeWorkflowSummary {
  name: string;
  desc: string;
}

/** More than this and the header starts competing with the chat for space. */
const MAX_LISTED = 8;
/** Caps the box width on wide terminals — an 800px-wide slab of text reads worse than a compact card. */
const MAX_BOX_WIDTH = 68;

/** The unboxed content lines — colored, not yet wrapped or framed. */
function contentLines(theme: Theme, workflows: WelcomeWorkflowSummary[]): string[] {
  const lines: string[] = [];
  lines.push(theme.bold(theme.fg("accent", "ralph-flow")) + theme.fg("muted", "  ·  DO → CHECK 工作流引擎"));

  if (workflows.length > 0) {
    lines.push("");
    const shown = workflows.slice(0, MAX_LISTED);
    const overflow = workflows.length - shown.length;
    const names = shown.map((w) => theme.fg("text", w.name)).join(theme.fg("muted", " · "));
    const suffix = overflow > 0 ? theme.fg("muted", ` (+${overflow})`) : "";
    lines.push(theme.fg("muted", "可用工作流：") + names + suffix);
  }

  lines.push("");
  lines.push(
    theme.fg("muted", '试试说 "用 spec 工作流帮我实现一个登录接口" 之类的话，或输入 ') + theme.fg("accent", "/ralphflow-start"),
  );
  return lines;
}

/**
 * Wraps colored lines in a rounded box, sized to fit `outerWidth` (capped at
 * MAX_BOX_WIDTH). Every body line is padded to the exact same visible width
 * so the right border lines up — the one detail that's easy to get subtly
 * wrong with ANSI-colored, CJK-mixed content, which is why it goes through
 * `visibleWidth` per line rather than `.length`.
 */
function boxIt(theme: Theme, lines: string[], outerWidth: number): string[] {
  const border = (s: string) => theme.fg("borderAccent", s);
  const innerWidth = Math.max(20, Math.min(MAX_BOX_WIDTH, outerWidth) - 4); // "│ " + content + " │"

  const wrapped: string[] = [];
  for (const line of lines) {
    if (line === "") { wrapped.push(""); continue; }
    wrapped.push(...wrapTextWithAnsi(line, innerWidth));
  }

  const top = border(`╭${"─".repeat(innerWidth + 2)}╮`);
  const bottom = border(`╰${"─".repeat(innerWidth + 2)}╯`);
  const body = wrapped.map((line) => {
    const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
    return border("│ ") + line + pad + border(" │");
  });
  return [top, ...body, bottom];
}

/** The actual content, separated from the pi-tui plumbing so it's testable headlessly. */
export function buildWelcomeLines(theme: Theme, workflows: WelcomeWorkflowSummary[], width: number): string[] {
  return boxIt(theme, contentLines(theme, workflows), width);
}

/**
 * `listWorkflows` is a thunk, not a snapshot — `setHeader`'s factory runs once
 * at session start, but the header component's own `render()` runs on every
 * redraw, so re-listing each time keeps it honest if workflows change (a
 * project file edited mid-session, `ralphflow doctor` fixing something) —
 * cheap enough (`engine.listWorkflows()` is a directory scan, not a build).
 */
export function createWelcomeHeaderFactory(
  listWorkflows: () => Array<{ name: string; desc: string; invalid?: boolean }>,
) {
  return (_tui: unknown, theme: Theme): Component => ({
    render(width: number): string[] {
      const workflows = listWorkflows().filter((w) => !w.invalid);
      return buildWelcomeLines(theme, workflows, width);
    },
    // Nothing cached — every render() call already re-lists workflows and
    // re-reads theme colors from scratch, so there's no state to drop.
    invalidate() {},
  });
}
