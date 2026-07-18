/**
 * The pure renderer. Since render.ts has no I/O, the entire on-screen look is
 * asserted here — what the user sees is a tested function of the run model.
 *
 * Assertions strip ANSI and check the visible text + structure, so they don't
 * break on a color tweak but do catch "the verdict reason vanished" or "the step
 * strip lost a step".
 */

import { describe, it, expect } from "vitest";
import {
  renderScreen, renderStream, renderStatus, renderStepStrip, renderBlock, renderAction, wrap, visibleLength,
} from "../tui/render.js";
import {
  applyGate, applyPaused, applyStepEvent, applyStepStart, applyUserMessage, applyVerdict, applyCompleted, initRunModel, type RunModel,
} from "../tui/run-model.js";
import type { WorkflowDef } from "../engine/types.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const flat = (lines: string[]) => lines.map(strip).join("\n");

const WF: WorkflowDef = {
  name: "spec",
  description: "spec workflow",
  manual_step: [],
  steps: [
    { id: "propose", desc: "需求分析", do: "d", check: "c", input: "i", output: "o", on_pass: "impl", on_fail: "propose", max_fail_count: 3 },
    { id: "impl", desc: "实现", do: "d", check: "c", input: "i", output: "o", on_pass: "done", on_fail: "impl", max_fail_count: 5 },
  ],
};

function model(): RunModel {
  return initRunModel("spec-1", WF, "加一个登录接口");
}

describe("wrap", () => {
  it("wraps long lines to width and preserves short ones", () => {
    expect(wrap("hello", 20)).toEqual(["hello"]);
    const wrapped = wrap("one two three four five", 9);
    expect(wrapped.every((l) => visibleLength(l) <= 9)).toBe(true);
    expect(wrapped.join(" ")).toBe("one two three four five");
  });

  it("hard-splits a word longer than the width", () => {
    const wrapped = wrap("abcdefghij", 4);
    expect(wrapped).toEqual(["abcd", "efgh", "ij"]);
  });

  it("respects explicit newlines", () => {
    expect(wrap("a\nb", 80)).toEqual(["a", "b"]);
  });
});

describe("step strip", () => {
  it("shows an icon for every step and names the active one", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    const out = flat(renderStepStrip(m, 80));
    expect(out).toContain("需求分析");
    expect(out).toContain("DO");
    // Two steps → two icons.
    expect((out.match(/[○▶🔍✓✗📋]/gu) || []).length).toBe(2);
  });

  it("shows elapsed time on the active phase, ticking off a fixed clock so it's deterministic", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    const startedAt = m.phaseStartedAt!;

    expect(flat(renderStepStrip(m, 80, startedAt))).toContain("0s");
    expect(flat(renderStepStrip(m, 80, startedAt + 42_000))).toContain("42s");
    expect(flat(renderStepStrip(m, 80, startedAt + 65_000))).toContain("1m05s");
    expect(flat(renderStepStrip(m, 80, startedAt + 3 * 60_000 + 7_000))).toContain("3m07s");
  });

  it("shows no elapsed time once the phase clock has stopped (gate/paused/stalled/completed)", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    applyGate(m, "propose");
    const out = flat(renderStepStrip(m, 80, Date.now() + 999_000));
    expect(out).not.toMatch(/\d+(m\d+)?s\b/);
  });

  it("reflects passed/pending status", () => {
    const m = model();
    applyStepStart(m, "propose", "check", 1);
    applyVerdict(m, "propose", { passed: true, reason: "ok" });
    const out = flat(renderStepStrip(m, 80));
    expect(out).toContain("✓"); // propose passed
    expect(out).toContain("○"); // impl pending
  });
});

describe("stream blocks", () => {
  it("dims reasoning and shows text plainly", () => {
    const rBlock = renderBlock({ kind: "reasoning", text: "let me think" }, 80);
    expect(rBlock.join("")).toContain("\x1b[2m"); // dim code present
    expect(flat(rBlock)).toContain("let me think");

    const tBlock = renderBlock({ kind: "text", text: "here is the result" }, 80);
    expect(flat(tBlock)).toContain("here is the result");
  });

  it("renders a tool call with its arg and result lines", () => {
    const out = flat(renderBlock({ kind: "tool", name: "write", arg: "design.md", status: "ok", result: "wrote 3 lines" }, 80));
    expect(out).toContain("write");
    expect(out).toContain("design.md");
    expect(out).toContain("wrote 3 lines");
  });

  it("shows a multi-line tool result (a diff or command output)", () => {
    const diff = "+ added line\n- removed line\n  context";
    const out = flat(renderBlock({ kind: "tool", name: "edit", arg: "a.ts", status: "ok", result: diff }, 80));
    expect(out).toContain("added line");
    expect(out).toContain("removed line");
  });

  it("renders a pass verdict with its reason", () => {
    const out = flat(renderBlock({ kind: "verdict", passed: true, infra: false, reason: "构建通过，12/12 测试绿" }, 80));
    expect(out).toContain("通过");
    expect(out).toContain("12/12");
  });

  it("frames an infra verdict as not-a-work-failure", () => {
    const out = flat(renderBlock({ kind: "verdict", passed: false, infra: true, reason: "no api key" }, 80));
    expect(out).toContain("验证未能运行");
    expect(out).not.toContain("未通过");
  });

  it("streams the active step's whole timeline", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    applyStepEvent(m, "propose", "do", { type: "reasoning", delta: "planning" });
    applyStepEvent(m, "propose", "do", { type: "tool_start", toolCallId: "1", toolName: "write", args: { file_path: "proposal.md" } });
    applyStepEvent(m, "propose", "do", { type: "tool_end", toolCallId: "1", toolName: "write", isError: false, text: "ok" });
    const out = flat(renderStream(m, 80));
    expect(out).toContain("planning");
    expect(out).toContain("write");
    expect(out).toContain("proposal.md");
  });

  it("renders a human message distinctly from the agent's own output", () => {
    const out = flat(renderBlock({ kind: "user", text: "先别用这个方案，改用 B 方案" }, 80));
    expect(out).toContain("先别用这个方案，改用 B 方案");
    expect(out).toContain("你");
  });
});

describe("status block and actions", () => {
  it("always shows workflow, task and progress", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    const out = flat(renderStatus(m, 80));
    expect(out).toContain("spec");
    expect(out).toContain("加一个登录接口");
    // The first (of two) steps is active — 1-indexed ordinal, not a "how many
    // fully finished" count that reads 0 for the entire run until the very end
    // (see run-model.test.ts's progress() coverage for that regression).
    expect(out).toContain("步骤 1/2");
    expect(out).toContain("需求分析"); // what this step actually does
    expect(out).toContain("DO"); // which phase
    expect(out).toContain("运行中");
  });

  it("a gate points at typing a revision or the /ralphflow-continue and /ralphflow-cancel commands", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    applyGate(m, "propose");
    const out = flat(renderAction(m, 80));
    expect(out).toContain("/ralphflow-continue");
    expect(out).toContain("/ralphflow-cancel");
    expect(out).not.toMatch(/\[y\]|\[e\]|\[c\]/); // no modal single-key hints anymore
  });

  it("a pause points at leaving a note and /ralphflow-continue, with its reason", () => {
    const m = model();
    applyPaused(m, { active: true, workflow_name: "spec", current_step: "impl", current_phase: "check", fail_count: 5, user_task: "t", paused: true, pause_reason: "max_failures", last_failure_reason: "测试挂了" });
    const out = flat(renderAction(m, 80));
    expect(out).toContain("测试挂了");
    expect(out).toContain("/ralphflow-continue");
    expect(out).not.toMatch(/\[r\]|\[c\]/);
  });

  it("completion shows the report path", () => {
    const m = model();
    applyCompleted(m, "/proj/.ralph-flow/reports/spec-1-final-report.md");
    const out = flat(renderAction(m, 80));
    expect(out).toContain("工作流完成");
    expect(out).toContain("spec-1-final-report.md");
  });
});

describe("whole screen", () => {
  it("puts the stream above and the status block below", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    applyStepEvent(m, "propose", "do", { type: "text", delta: "working on the proposal" });
    const lines = renderScreen(m, 80).map(strip);
    const streamIdx = lines.findIndex((l) => l.includes("working on the proposal"));
    const statusIdx = lines.findIndex((l) => l.includes("加一个登录接口"));
    expect(streamIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(streamIdx); // status is below the stream
  });

  it("scrollBack reveals older stream lines while keeping the status block", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    for (let i = 0; i < 30; i++) applyStepEvent(m, "propose", "do", { type: "text", delta: `line ${i}\n` });
    const scrolled = renderScreen(m, 80, 10).map(strip);
    // Status block still present.
    expect(scrolled.some((l) => l.includes("加一个登录接口"))).toBe(true);
  });

  it("keeps the document's total length invariant across scrollBack — a real user-reported bug: pi-tui's TUI has no scroll viewport, it just redraws the tail of whatever this returns, so shrinking the array on scroll made the bottom-anchored status block visibly slide up the screen on every Up-arrow press before any real scrolling happened", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    for (let i = 0; i < 30; i++) applyStepEvent(m, "propose", "do", { type: "text", delta: `line ${i}\n` });
    const base = renderScreen(m, 80, 0).length;
    for (const scrollBack of [1, 5, 10, 29, 30, 500]) { // 500: past all available content
      expect(renderScreen(m, 80, scrollBack).length).toBe(base);
    }
  });

  it("the status block sits at the exact same offset from the end of the document regardless of scrollBack — this is what makes it read as visually pinned", () => {
    const m = model();
    applyStepStart(m, "propose", "do", 1);
    for (let i = 0; i < 30; i++) applyStepEvent(m, "propose", "do", { type: "text", delta: `line ${i}\n` });
    const statusHeight = flat(renderStatus(m, 80)).split("\n").length;
    for (const scrollBack of [0, 5, 20, 100]) {
      const doc = renderScreen(m, 80, scrollBack);
      const tail = doc.slice(doc.length - statusHeight).map(strip).join("\n");
      expect(tail).toContain("加一个登录接口"); // status content, at the same relative position every time
    }
  });

  it("every line fits the width — across states, narrow widths, and wide chars", () => {
    // pi-tui THROWS if any rendered line exceeds the terminal width (counting
    // CJK/emoji as 2 columns), so this must hold for every screen we can produce.
    const scenarios: Array<(m: any) => void> = [
      (m) => { applyStepStart(m, "propose", "do", 1); applyStepEvent(m, "propose", "do", { type: "text", delta: "中文很多很多很多很多很多很多很多很多的输出内容 " + "a ".repeat(100) }); },
      (m) => { applyStepStart(m, "propose", "do", 1); applyStepEvent(m, "propose", "do", { type: "reasoning", delta: "思考".repeat(80) }); },
      (m) => { applyStepStart(m, "propose", "do", 1); applyStepEvent(m, "propose", "do", { type: "tool_start", toolCallId: "1", toolName: "bash", args: { command: "cargo test ".repeat(30) } }); applyStepEvent(m, "propose", "do", { type: "tool_end", toolCallId: "1", toolName: "bash", isError: false, text: "输出".repeat(200) }); },
      (m) => { applyStepStart(m, "propose", "do", 1); applyGate(m, "propose"); },
      (m) => { applyPaused(m, { active: true, workflow_name: "spec", current_step: "impl", current_phase: "check", fail_count: 5, user_task: "任务".repeat(50), paused: true, pause_reason: "max_failures", last_failure_reason: "失败原因".repeat(40) }); },
      (m) => { applyCompleted(m, "/very/long/path/".repeat(10) + "report.md"); },
      (m) => { applyStepStart(m, "propose", "do", 1); applyUserMessage(m, "propose", "先别用这个方案".repeat(40)); },
    ];
    for (const width of [20, 40, 80, 120]) {
      for (const setup of scenarios) {
        const m = initRunModel("spec-1", WF, "加一个登录接口，需求很长很长很长很长很长很长很长很长");
        setup(m);
        for (const line of renderScreen(m, width)) {
          expect(visibleLength(line), `width=${width} line="${strip(line)}"`).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});
