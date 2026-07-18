/**
 * The run view's state reducer.
 *
 * Two layers of testing:
 *  1. Direct reducer tests — feed synthetic events, assert the state. This is
 *     where streaming/coalescing and the step-status transitions are pinned.
 *  2. Integration — wire the reducer to the REAL runner via a helper, drive a
 *     whole workflow with FakeAdapter, and assert the user would see a coherent
 *     pipeline. This proves the structured runner events and the reducer agree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import { createRunner, type RunnerEvents } from "../engine/runner.js";
import { createTools } from "../commands/tools.js";
import type { ToolDefinition, StepEvent } from "../pi/adapter.js";
import {
  applyCancelled, applyCompleted, applyGate, applyPaused, applyStalled, applyStepEvent, applyStepStart, applyUserMessage, applyVerdict,
  initRunModel, needsUser, primeForAttach, progress, type RunModel,
} from "../tui/run-model.js";
import { createFakeAdapter, createFakeCheckAdapter, type Turn } from "./fake-adapter.js";

const SIMPLE_WF = `
description: test workflow
steps:
  - id: one
    desc: first step
    do: do one
    check: check one
    input: user input
    output: "out1.md"
    on_pass: two
    on_fail: one
    max_fail_count: 3
  - id: two
    desc: second step
    do: do two
    check: check two
    input: out1.md
    output: "out2.md"
    on_pass: done
    on_fail: two
    max_fail_count: 2
`;

let tmpDir: string;
let engine: Engine;

function writeWorkflow(name: string, content: string): void {
  const dir = path.join(tmpDir, ".ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-runmodel-"));
  engine = createEngine(tmpDir, {}) as Engine;
  writeWorkflow("test-wf", SIMPLE_WF);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function model(): RunModel {
  return initRunModel("inst-1", engine.loadWorkflow("test-wf")!, "my task");
}

const text = (delta: string): StepEvent => ({ type: "text", delta });
const reasoning = (delta: string): StepEvent => ({ type: "reasoning", delta });
const toolStart = (name: string, args: unknown): StepEvent => ({ type: "tool_start", toolCallId: "c1", toolName: name, args });
const toolEnd = (name: string, isError: boolean, text: string): StepEvent => ({ type: "tool_end", toolCallId: "c1", toolName: name, isError, text });

describe("initial model", () => {
  it("lays out the whole pipeline up front", () => {
    const m = model();
    expect(m.steps.map((s) => s.id)).toEqual(["one", "two"]);
    expect(m.steps.every((s) => s.status === "pending")).toBe(true);
    expect(m.status).toBe("running");
    expect(progress(m)).toEqual({ done: 0, total: 2 });
  });

  it("has no phase clock running before anything starts", () => {
    expect(model().phaseStartedAt).toBeNull();
  });
});

describe("phaseStartedAt: the elapsed-time clock", () => {
  it("starts the clock when a phase starts, and a retry restarts it", async () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    expect(m.phaseStartedAt).not.toBeNull();
    const firstStart = m.phaseStartedAt!;

    await new Promise((r) => setTimeout(r, 5));
    applyStepStart(m, "one", "check", 1); // phase change resets the clock
    expect(m.phaseStartedAt!).toBeGreaterThanOrEqual(firstStart);
  });

  it("stops the clock on every path that clears activePhase", () => {
    for (const apply of [
      (m: RunModel) => applyGate(m, "one"),
      (m: RunModel) => applyPaused(m, { active: true, workflow_name: "spec", current_step: "one", current_phase: "do", fail_count: 1, user_task: "t", paused: true, pause_reason: "max_failures" }),
      (m: RunModel) => applyStalled(m, "one", 6),
      (m: RunModel) => applyCompleted(m, "/report.md"),
      (m: RunModel) => applyCancelled(m),
    ]) {
      const m = model();
      applyStepStart(m, "one", "do", 1);
      expect(m.phaseStartedAt).not.toBeNull();
      apply(m);
      expect(m.activePhase).toBeNull();
      expect(m.phaseStartedAt).toBeNull();
    }
  });
});

describe("streaming coalescing", () => {
  it("merges consecutive reasoning deltas into one block", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepEvent(m, "one", "do", reasoning("Let me "));
    applyStepEvent(m, "one", "do", reasoning("think..."));
    const blocks = m.streams.get("one")!.filter((b) => b.kind === "reasoning");
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text).toBe("Let me think...");
  });

  it("merges text deltas but keeps reasoning and text as separate blocks", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepEvent(m, "one", "do", reasoning("thinking"));
    applyStepEvent(m, "one", "do", text("output A"));
    applyStepEvent(m, "one", "do", text(" output B"));
    const kinds = m.streams.get("one")!.map((b) => b.kind);
    expect(kinds).toEqual(["phase", "reasoning", "text"]);
    const textBlock = m.streams.get("one")!.find((b) => b.kind === "text") as any;
    expect(textBlock.text).toBe("output A output B");
  });

  it("pairs a tool_start with its tool_end and captures the result", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepEvent(m, "one", "do", toolStart("write", { file_path: "out1.md" }));
    applyStepEvent(m, "one", "do", toolEnd("write", false, "wrote 3 lines"));
    const tool = m.streams.get("one")!.find((b) => b.kind === "tool") as any;
    expect(tool.name).toBe("write");
    expect(tool.arg).toBe("out1.md");
    expect(tool.status).toBe("ok");
    expect(tool.result).toBe("wrote 3 lines");
  });

  it("marks an errored tool", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepEvent(m, "one", "do", toolStart("bash", { command: "rm -rf x" }));
    applyStepEvent(m, "one", "do", toolEnd("bash", true, "命令被拒绝"));
    const tool = m.streams.get("one")!.find((b) => b.kind === "tool") as any;
    expect(tool.status).toBe("error");
    expect(tool.arg).toBe("rm -rf x");
  });
});

describe("step status transitions", () => {
  it("do → check → passed → done on completion", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    expect(m.steps[0].status).toBe("do");
    applyStepStart(m, "one", "check", 1);
    expect(m.steps[0].status).toBe("check");
    applyVerdict(m, "one", { passed: true, reason: "looks good" });
    expect(m.steps[0].status).toBe("passed");
    expect(m.steps[0].lastReason).toBe("looks good");
    applyCompleted(m);
    expect(m.steps[0].status).toBe("done");
  });

  it("progress() counts a mid-workflow 'passed' step as done — a real user-reported bug: it read 0/N for the entire run, only jumping to N/N at the very last moment, because 'passed' only gets promoted to 'done' in applyCompleted, at the end", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepStart(m, "one", "check", 1);
    applyVerdict(m, "one", { passed: true, reason: "ok" });
    expect(m.steps[0].status).toBe("passed"); // not yet promoted to "done"
    applyStepStart(m, "two", "do", 1);
    expect(progress(m)).toEqual({ done: 1, total: 2 }); // must count "one" anyway
  });

  it("a failed verdict marks the step failed with the reason", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepStart(m, "one", "check", 1);
    applyVerdict(m, "one", { passed: false, reason: "缺少 out1.md" });
    expect(m.steps[0].status).toBe("failed");
    expect(m.steps[0].lastReason).toBe("缺少 out1.md");
  });

  it("an infra verdict does NOT change the step status", () => {
    const m = model();
    applyStepStart(m, "one", "check", 1);
    applyVerdict(m, "one", { passed: false, infra: true, reason: "no api key" });
    expect(m.steps[0].status).toBe("check"); // work wasn't judged
  });

  it("a retry appends to the same step's stream and updates attempt", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepEvent(m, "one", "do", text("first try"));
    applyStepStart(m, "one", "check", 1);
    applyVerdict(m, "one", { passed: false, reason: "nope" });
    applyStepStart(m, "one", "do", 2); // retry
    expect(m.steps[0].attempts).toBe(2);
    // Same stream, both attempts visible.
    const phases = m.streams.get("one")!.filter((b) => b.kind === "phase");
    expect(phases).toHaveLength(3); // do1, check1, do2
  });

  it("a human steer appends a user block to the active step's stream without changing status", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyStepEvent(m, "one", "do", text("thinking about it"));
    applyUserMessage(m, "one", "先别用这个方案，改用 B 方案");
    const blocks = m.streams.get("one")!;
    expect(blocks[blocks.length - 1]).toEqual({ kind: "user", text: "先别用这个方案，改用 B 方案" });
    expect(m.status).toBe("running");
    expect(m.activePhase).toBe("do");
    expect(m.steps[0].status).toBe("do"); // untouched by a steer
  });

  it("a note left while resuming lands in the SAME step's stream a retry would use", () => {
    // pickAttemptDir/continueInstance resume a step's own session on retry —
    // applyUserMessage should file into that same per-step stream, so a note
    // left at a paused/stalled state reads as part of that step's ongoing
    // conversation, not a separate transcript.
    const m = model();
    applyStepStart(m, "impl", "do", 1);
    applyUserMessage(m, "impl", "API key 已经配好了，继续");
    expect(m.streams.get("impl")!.map((b) => b.kind)).toEqual(["phase", "user"]);
  });
});

describe("primeForAttach", () => {
  it("reattaching to a running instance sets activeStepId/activePhase/phaseStartedAt and marks prior-passed steps done, without touching the stream", () => {
    const m = model();
    const before = Date.now();
    primeForAttach(
      m,
      { active: true, workflow_name: "test-wf", current_step: "two", current_phase: "do", fail_count: 0, user_task: "t", paused: false },
      ["one"],
    );
    expect(m.steps[0].status).toBe("done"); // "one" already passed check
    expect(m.activeStepId).toBe("two");
    expect(m.activePhase).toBe("do");
    expect(m.steps[1].status).toBe("do");
    expect(m.steps[1].attempts).toBe(1);
    expect(m.phaseStartedAt).not.toBeNull();
    expect(m.phaseStartedAt!).toBeGreaterThanOrEqual(before);
    expect(m.streams.has("two")).toBe(false); // deliberately stream-mutation-free
  });

  it("reattaching to a paused instance still sets activeStepId (applyPaused doesn't touch it)", () => {
    const m = model();
    primeForAttach(
      m,
      { active: true, workflow_name: "test-wf", current_step: "one", current_phase: "check", fail_count: 3, user_task: "t", paused: true, pause_reason: "max_failures", last_failure_reason: "tests fail" },
      [],
    );
    applyPaused(m, { active: true, workflow_name: "test-wf", current_step: "one", current_phase: "check", fail_count: 3, user_task: "t", paused: true, pause_reason: "max_failures", last_failure_reason: "tests fail" });
    expect(m.activeStepId).toBe("one"); // preserved from primeForAttach
    expect(m.activePhase).toBeNull(); // overridden back by applyPaused
    expect(m.status).toBe("paused");
  });

  it("reflects fail_count into the step's attempt count (a retry in progress, not attempt 1)", () => {
    const m = model();
    primeForAttach(
      m,
      { active: true, workflow_name: "test-wf", current_step: "one", current_phase: "do", fail_count: 2, user_task: "t", paused: false },
      [],
    );
    expect(m.steps[0].attempts).toBe(3); // fail_count + 1
  });

  it("does not duplicate stream content when the real applyStepStart fires moments later (fresh-start race window)", () => {
    const m = model();
    primeForAttach(
      m,
      { active: true, workflow_name: "test-wf", current_step: "one", current_phase: "do", fail_count: 0, user_task: "t", paused: false },
      [],
    );
    applyStepStart(m, "one", "do", 1); // the "real" event arriving right after
    const phases = m.streams.get("one")!.filter((b) => b.kind === "phase");
    expect(phases).toHaveLength(1); // no duplicate divider from priming
  });

  it("a phase outside do/check (e.g. empty current_phase on a not-yet-started instance) leaves activePhase untouched", () => {
    const m = model();
    primeForAttach(
      m,
      { active: true, workflow_name: "test-wf", current_step: "one", current_phase: "", fail_count: 0, user_task: "t", paused: false },
      [],
    );
    expect(m.activeStepId).toBe("one");
    expect(m.activePhase).toBeNull();
  });
});

describe("user-action states", () => {
  it("gate sets status and a clear detail", () => {
    const m = model();
    applyStepStart(m, "one", "do", 1);
    applyGate(m, "one");
    expect(m.status).toBe("gate");
    expect(needsUser(m)).toBe(true);
    expect(m.statusDetail).toContain("审查");
    expect(m.steps[0].status).toBe("gate");
  });

  it("pause carries a human-readable reason per pause type", () => {
    const m = model();
    applyPaused(m, { active: true, workflow_name: "test-wf", current_step: "one", current_phase: "check", fail_count: 3, user_task: "t", paused: true, pause_reason: "max_failures", last_failure_reason: "tests fail" });
    expect(m.status).toBe("paused");
    expect(m.statusDetail).toContain("最大失败次数");
    expect(m.statusDetail).toContain("tests fail");
  });

  it("check_error pause is framed as not-your-fault", () => {
    const m = model();
    applyPaused(m, { active: true, workflow_name: "test-wf", current_step: "one", current_phase: "check", fail_count: 0, user_task: "t", paused: true, pause_reason: "check_error", last_failure_reason: "no api key" });
    expect(m.statusDetail).toContain("不计失败次数");
  });

  it("stalled explains the DO gave up", () => {
    const m = model();
    applyStalled(m, "one", 6);
    expect(m.status).toBe("stalled");
    expect(m.statusDetail).toContain("6");
  });
});

describe("integration: real runner drives the model", () => {
  /** Wire a fresh run-model to the real runner via structured events. */
  function drive(turns: Turn[], verdicts: Array<{ pass: boolean; reason?: string } | "silent">) {
    const wf = engine.loadWorkflow("test-wf")!;
    const instId = engine.generateInstanceId("test-wf");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.writeState({ active: true, workflow_name: "test-wf", current_step: "one", current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "s1" }, instId);
    engine.buildDoPrompt(instId, wf.steps[0] as any, "task");

    const m = initRunModel(instId, wf, "task");
    const events: RunnerEvents = {
      onStepStart: (_i, sid, phase, attempt) => applyStepStart(m, sid, phase, attempt),
      onStepEvent: (_i, sid, phase, e) => applyStepEvent(m, sid, phase, e),
      onVerdict: (_i, sid, r) => applyVerdict(m, sid, r),
      onGate: (_i, sid) => applyGate(m, sid),
      onPaused: (_i, st) => applyPaused(m, st),
      onStalled: (_i, sid, a) => applyStalled(m, sid, a),
      onCompleted: (_i, rp) => applyCompleted(m, rp),
    };
    const runner = createRunner(engine, events, {
      createSession: createFakeAdapter({ turns }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter(verdicts).createSession },
    });
    return { m, runner, instId };
  }

  it("a clean run leaves every step done and status completed", async () => {
    const { m, runner } = drive([{ done: true }], [{ pass: true, reason: "ok" }]);
    runner.ensureRunning(m.instanceId);
    await runner.idle();

    expect(m.status).toBe("completed");
    expect(m.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(progress(m)).toEqual({ done: 2, total: 2 });
  });

  it("each step gets its own stream — fresh context made visible", async () => {
    const { m, runner } = drive(
      [{ toolCalls: [{ name: "write", params: { file_path: "out.md" } }] }, { done: true }],
      [{ pass: true }],
    );
    runner.ensureRunning(m.instanceId);
    await runner.idle();

    // Both steps have their own timeline; step one shows its write tool call.
    expect(m.streams.has("one")).toBe(true);
    expect(m.streams.has("two")).toBe(true);
    const oneTools = m.streams.get("one")!.filter((b) => b.kind === "tool");
    expect(oneTools.some((b: any) => b.name === "write")).toBe(true);
  });

  it("a failing-then-passing run shows the retry and finishes", async () => {
    const { m, runner } = drive([{ done: true }], [{ pass: false, reason: "缺文件" }, { pass: true }]);
    runner.ensureRunning(m.instanceId);
    await runner.idle();

    expect(m.status).toBe("completed");
    expect(m.steps[0].attempts).toBe(2); // step one was retried
    // The first verdict's reason is visible in step one's stream.
    const verdicts = m.streams.get("one")!.filter((b) => b.kind === "verdict");
    expect(verdicts.some((v: any) => v.reason === "缺文件")).toBe(true);
  });

  it("a max-failure run ends paused with a reason, not completed", async () => {
    const { m, runner } = drive([{ done: true }], [{ pass: false, reason: "still broken" }]);
    runner.ensureRunning(m.instanceId);
    await runner.idle();

    expect(m.status).toBe("paused");
    expect(m.statusDetail).toContain("最大失败次数");
    expect(needsUser(m)).toBe(true);
  });

  it("an infra failure ends paused and never marks the step failed", async () => {
    const { m, runner } = drive([{ done: true }], ["silent"]);
    runner.ensureRunning(m.instanceId);
    await runner.idle();

    expect(m.status).toBe("paused");
    expect(m.statusDetail).toContain("不计失败次数");
    expect(m.steps[0].status).not.toBe("failed");
  });
});
