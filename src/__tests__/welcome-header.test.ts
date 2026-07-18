/**
 * buildWelcomeLines — the actual content of the branded startup header
 * (welcome-header.ts), tested headlessly. A real `Theme` instance is
 * required (its `.fg`/`.bold` methods are what the header calls), but the
 * exact colors don't matter for this suite — only that the workflow names
 * and hint text survive, that overflow past MAX_LISTED is summarized rather
 * than silently dropped, and that width-wrapping doesn't crash or lose text.
 */

import { describe, it, expect } from "vitest";
import { Theme, visibleWidth, type ThemeColor } from "../pi/tui.js";
import { buildWelcomeLines, type WelcomeWorkflowSummary } from "../tui/welcome-header.js";

/**
 * A real Theme needs every ThemeColor key present (its constructor copies the
 * map, so a Proxy that only implements get/has isn't enough — copying reads
 * via ownKeys, which a get-only Proxy doesn't answer). Content, not the exact
 * palette, is what this suite cares about, so every key gets the same
 * fallback — but `satisfies Record<ThemeColor, string>` still makes the
 * compiler catch it if pi ever adds/removes a ThemeColor this list misses.
 */
const FG: Record<ThemeColor, string> = {
  accent: "#ffffff", border: "#ffffff", borderAccent: "#ffffff", borderMuted: "#ffffff",
  success: "#ffffff", error: "#ffffff", warning: "#ffffff", muted: "#ffffff", dim: "#ffffff", text: "#ffffff",
  thinkingText: "#ffffff", userMessageText: "#ffffff", customMessageText: "#ffffff", customMessageLabel: "#ffffff",
  toolTitle: "#ffffff", toolOutput: "#ffffff",
  mdHeading: "#ffffff", mdLink: "#ffffff", mdLinkUrl: "#ffffff", mdCode: "#ffffff", mdCodeBlock: "#ffffff",
  mdCodeBlockBorder: "#ffffff", mdQuote: "#ffffff", mdQuoteBorder: "#ffffff", mdHr: "#ffffff", mdListBullet: "#ffffff",
  toolDiffAdded: "#ffffff", toolDiffRemoved: "#ffffff", toolDiffContext: "#ffffff",
  syntaxComment: "#ffffff", syntaxKeyword: "#ffffff", syntaxFunction: "#ffffff", syntaxVariable: "#ffffff",
  syntaxString: "#ffffff", syntaxNumber: "#ffffff", syntaxType: "#ffffff", syntaxOperator: "#ffffff", syntaxPunctuation: "#ffffff",
  thinkingOff: "#ffffff", thinkingMinimal: "#ffffff", thinkingLow: "#ffffff", thinkingMedium: "#ffffff",
  thinkingHigh: "#ffffff", thinkingXhigh: "#ffffff", thinkingMax: "#ffffff", bashMode: "#ffffff",
};
const BG = {
  selectedBg: "#000000", userMessageBg: "#000000", customMessageBg: "#000000",
  toolPendingBg: "#000000", toolSuccessBg: "#000000", toolErrorBg: "#000000",
};
const testTheme = new Theme(FG, BG as any, "truecolor");

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const WORKFLOWS: WelcomeWorkflowSummary[] = [
  { name: "smoke", desc: "smoke test" },
  { name: "spec", desc: "spec workflow" },
  { name: "loop", desc: "loop workflow" },
];

describe("buildWelcomeLines", () => {
  it("names the product and lists the given workflows", () => {
    const lines = buildWelcomeLines(testTheme, WORKFLOWS, 80).map(stripAnsi);
    const joined = lines.join("\n");
    expect(joined).toContain("ralph-flow");
    expect(joined).toContain("smoke");
    expect(joined).toContain("spec");
    expect(joined).toContain("loop");
  });

  it("includes the /ralphflow-start hint", () => {
    const lines = buildWelcomeLines(testTheme, WORKFLOWS, 80).map(stripAnsi);
    expect(lines.join("\n")).toContain("/ralphflow-start");
  });

  it("summarizes overflow instead of listing every workflow unbounded", () => {
    const many: WelcomeWorkflowSummary[] = Array.from({ length: 12 }, (_, i) => ({ name: `wf-${i}`, desc: "" }));
    const lines = buildWelcomeLines(testTheme, many, 200).map(stripAnsi);
    const joined = lines.join("\n");
    expect(joined).toContain("wf-0");
    expect(joined).toContain("+4"); // 12 total, 8 shown, 4 overflow
    expect(joined).not.toContain("wf-11"); // past the cap
  });

  it("says nothing about workflows when there are none, rather than an empty label", () => {
    const lines = buildWelcomeLines(testTheme, [], 80).map(stripAnsi);
    expect(lines.join("\n")).not.toContain("可用工作流");
  });

  it("never emits a line wider than the given width", () => {
    const lines = buildWelcomeLines(testTheme, WORKFLOWS, 24);
    for (const line of lines) {
      expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(24);
    }
  });

  it("draws a box whose every line — including CJK-padded body lines — has exactly the same visible width", () => {
    // Mixed ASCII/CJK on purpose: a padding calculation using .length instead
    // of visibleWidth would under-pad CJK lines and misalign the right border
    // by exactly the number of CJK characters — this is the one bug class a
    // pure width-ceiling check (the test above) can't catch, since a wrong
    // pad is still <= the ceiling, just inconsistent between lines.
    const mixed: WelcomeWorkflowSummary[] = [
      { name: "spec", desc: "" },
      { name: "工作流甲", desc: "" },
      { name: "工作流乙丙丁", desc: "" },
    ];
    const raw = buildWelcomeLines(testTheme, mixed, 80);
    const widths = raw.map((l) => visibleWidth(stripAnsi(l)));
    expect(new Set(widths).size).toBe(1);

    const clean = raw.map(stripAnsi);
    expect(clean[0].startsWith("╭") && clean[0].endsWith("╮")).toBe(true);
    expect(clean[clean.length - 1].startsWith("╰") && clean[clean.length - 1].endsWith("╯")).toBe(true);
    for (const line of clean.slice(1, -1)) {
      expect(line.startsWith("│") && line.endsWith("│")).toBe(true);
    }
  });
});
