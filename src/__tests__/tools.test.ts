/**
 * The six ralphflow_* tools.
 *
 * ralphflow_continue carries most of the risk: six branches, each meaning
 * something different to a user who typed the same command. Approving a review
 * must not re-run the work; resuming an API outage must not burn a retry;
 * recovering a crash must not skip the step. They are all one `if` away from
 * each other, so each gets a test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import type { Runner } from "../engine/runner.js";
import { createTools } from "../commands/tools.js";
import type { ToolDefinition } from "../pi/adapter.js";

let tmpDir: string;
let engine: Engine;
let tools: Record<string, ToolDefinition>;
/** Instances the tools handed to the runner. */
let driven: string[];
const SESSION = "sess-main";

/**
 * A runner that records instead of running. These tests are about what each
 * tool does to the state files and what it tells the user; the loop that picks
 * the instance up afterwards is runner.test.ts's job. Using a real runner here
 * would also race every assertion — the loop consumes markers (.done-reported)
 * the moment it starts.
 */
function stubRunner(): Runner {
  return {
    ensureRunning: (instId: string) => { driven.push(instId); },
    reviseGate: () => {},
    sendUserMessage: () => false,
    addEventListener: () => () => {},
    abortActiveStep: () => {},
    isRunning: () => false,
    idle: async () => {},
    pauseAllForShutdown: () => {},
  };
}

/**
 * Fake ctx.ui.custom: the tools' state-machine correctness is what's under
 * test here, not the run view it now attaches (that's run-model.test.ts /
 * render.test.ts / dispatch-input.test.ts / manual E2E's job) — so this
 * skips invoking the real factory entirely and just resolves as if the user
 * immediately detached, matching Pi's real `ui.custom` shape closely enough
 * for these tests.
 */
function fakeCtx(): any {
  return { ui: { custom: async (_factory: unknown) => ({ outcome: "detached" }) } };
}

/** Same shape, but resolves as if the workflow ran to a terminal state — for
 *  asserting that `terminate` is a "detach only" signal, not blanket-applied. */
function fakeCtxWithOutcome(outcome: "completed" | "cancelled"): any {
  return { ui: { custom: async (_factory: unknown) => ({ outcome, reportPath: outcome === "completed" ? "/tmp/report.md" : undefined }) } };
}

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

function writeWorkflow(name: string, content: string): void {
  const dir = path.join(tmpDir, ".ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), content);
}

/** Call a tool the way the agent runtime would; returns its text. */
async function call(name: string, params: unknown = {}): Promise<string> {
  const result: any = await (tools[name] as any).execute("c1", params, undefined, undefined, fakeCtx());
  return result.content[0].text;
}

/** Same, but returns the full AgentToolResult — for asserting on `terminate`. */
async function callRaw(name: string, params: unknown = {}): Promise<any> {
  return (tools[name] as any).execute("c1", params, undefined, undefined, fakeCtx());
}

/** Like callRaw, but with a caller-supplied ctx (for a non-"detached" outcome). */
async function callRawWithCtx(name: string, params: unknown, ctx: any): Promise<any> {
  return (tools[name] as any).execute("c1", params, undefined, undefined, ctx);
}

/** An instance parked in a given state, without going through start. */
function seedInstance(overrides: Partial<Parameters<Engine["writeState"]>[0]> = {}): string {
  const instId = engine.generateInstanceId("test-wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState({
    active: true, workflow_name: "test-wf", current_step: "one", current_phase: "do",
    fail_count: 0, user_task: "task", paused: false, session_id: SESSION, ...overrides,
  }, instId);
  return instId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-tools-test-"));
  engine = createEngine(tmpDir, {}) as Engine;
  writeWorkflow("test-wf", SIMPLE_WF);
  driven = [];
  const list = createTools({ engine, runner: stubRunner(), getSessionId: () => SESSION });
  tools = Object.fromEntries(list.map((t) => [t.name, t]));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ralphflow_start", () => {
  it("creates an instance owned by this session and reports the step overview", async () => {
    const out = await call("ralphflow_start", { workflow: "test-wf", task: "build it" });
    expect(out).toContain("已启动");
    expect(out).toContain("## 步骤概览");
    expect(out).toContain("**one**");
    expect(out).toContain("**two**");

    const instances = engine.listInstances();
    expect(instances.length).toBe(1);
    expect(instances[0].owner).toBe(SESSION);
    expect(instances[0].state.user_task).toBe("build it");
    expect(instances[0].state.current_step).toBe("one");
  });

  it("the detach message tells the user exactly how to look again, and terminate — not word choice — is what stops the model from acting on it itself", async () => {
    // fakeCtx() resolves every attach as "detached". Naming /ralphflow-watch
    // here is deliberate (the user asked "tell me what command to use"),
    // unlike the earlier "...or I could call ralphflow_watch to check again"
    // wording that read as an open invitation TO THE MODEL and caused a real
    // polling loop — the difference is `terminate: true` ends this turn right
    // here regardless of what the text says, so the model has no opportunity
    // to act on the mention even though the human reading the transcript does.
    const result = await callRaw("ralphflow_start", { workflow: "test-wf", task: "build it" });
    const out = result.content[0].text;
    expect(out).toContain("已切回聊天");
    expect(out).toContain("/ralphflow-watch");
    expect(result.terminate).toBe(true);
  });

  it("sets terminate:true on a detach — the actual stop, not just inert wording", async () => {
    // AgentToolResult.terminate tells pi's agent loop to end the turn after
    // this tool batch, so the model never gets a chance to reason its way
    // into another tool call in the same breath as the detach. Wording alone
    // (the test above) was tried first and wasn't sufficient on its own.
    const result = await callRaw("ralphflow_start", { workflow: "test-wf", task: "build it" });
    expect(result.terminate).toBe(true);
  });

  it("does NOT set terminate on completed/cancelled — those are legitimate places for the model to report to the user", async () => {
    const completed = await callRawWithCtx(
      "ralphflow_start", { workflow: "test-wf", task: "build it" }, fakeCtxWithOutcome("completed"),
    );
    expect(completed.terminate).toBeFalsy();
    expect(completed.content[0].text).toContain("工作流完成");
  });

  it("calls ctx.abort() on detach — real-terminal testing showed terminate's per-batch requirement is not enough by itself", async () => {
    let aborted = false;
    const ctx = { ...fakeCtx(), abort: () => { aborted = true; } };
    await callRawWithCtx("ralphflow_start", { workflow: "test-wf", task: "build it" }, ctx);
    expect(aborted).toBe(true);
  });

  it("does not call ctx.abort() on completed/cancelled", async () => {
    let aborted = false;
    const ctx = { ...fakeCtxWithOutcome("completed"), abort: () => { aborted = true; } };
    await callRawWithCtx("ralphflow_start", { workflow: "test-wf", task: "build it" }, ctx);
    expect(aborted).toBe(false);
  });

  it("does not throw when ctx has no abort() at all (headless-shaped ctx)", async () => {
    const result = await callRaw("ralphflow_start", { workflow: "test-wf", task: "build it" });
    expect(result.terminate).toBe(true); // fakeCtx() has no abort; must not throw
  });

  it("allows a second instance for the same session (one session, several workflows)", async () => {
    const first = await call("ralphflow_start", { workflow: "test-wf", task: "a" });
    const second = await call("ralphflow_start", { workflow: "test-wf", task: "b" });
    expect(first).not.toContain("已有活跃工作流实例");
    expect(second).not.toContain("已有活跃工作流实例");
    const instances = engine.listInstances();
    expect(instances.length).toBe(2);
    expect(instances.every((i) => i.owner === SESSION)).toBe(true);
  });

  it("declares sequential execution — same-turn batches of start/continue/watch must not race the shared TUI", () => {
    expect((tools.ralphflow_start as any).executionMode).toBe("sequential");
    expect((tools.ralphflow_continue as any).executionMode).toBe("sequential");
    expect((tools.ralphflow_watch as any).executionMode).toBe("sequential");
  });

  it("explains WHY an invalid workflow cannot start", async () => {
    writeWorkflow("broken", `
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: ghost
    on_fail: a
    max_fail_count: 1
`);
    const out = await call("ralphflow_start", { workflow: "broken", task: "t" });
    expect(out).toContain("定义无效");
    expect(out).toContain("ghost");
    expect(engine.listInstances().length).toBe(0);
  });

  it("lists alternatives when the workflow is missing", async () => {
    const out = await call("ralphflow_start", { workflow: "nope", task: "t" });
    expect(out).toContain("未找到");
    expect(out).toContain("test-wf");
  });

  it("refuses a nonexistent extra_dir and creates nothing", async () => {
    const out = await call("ralphflow_start", { workflow: "test-wf", task: "t", extra_dirs: ["/definitely/not/here"] });
    expect(out).toContain("extra_dirs 校验失败");
    expect(engine.listInstances().length).toBe(0);
  });

  it("records validated extra_dirs for the verifier", async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "extra-"));
    const out = await call("ralphflow_start", { workflow: "test-wf", task: "t", extra_dirs: [extra] });
    expect(out).toContain("验证器额外可读目录");
    expect(engine.readExtraDirs(engine.listInstances()[0].id)).toEqual([extra]);
    fs.rmSync(extra, { recursive: true, force: true });
  });

  it("caches the DO prompt so the runner's first turn is the real task", async () => {
    await call("ralphflow_start", { workflow: "test-wf", task: "build it" });
    const cached = engine.readDoPromptCache(engine.listInstances()[0].id);
    expect(cached).toContain("do one");
    expect(cached).toContain("build it");
    expect(cached).toContain("report_done");
  });

  it("hands the new instance to the runner", async () => {
    // Without this the workflow would start and then sit there forever.
    await call("ralphflow_start", { workflow: "test-wf", task: "t" });
    expect(driven).toEqual([engine.listInstances()[0].id]);
  });

  it("does not start the runner for a workflow that failed to start", async () => {
    await call("ralphflow_start", { workflow: "nope", task: "t" });
    expect(driven).toEqual([]);
  });
});

describe("ralphflow_continue", () => {
  it("branch 1: clears a check_error pause and re-verifies without burning a retry", async () => {
    const instId = seedInstance({ current_phase: "check", paused: true, pause_reason: "check_error", fail_count: 1 });
    const out = await call("ralphflow_continue");
    expect(out).toContain("验证基础设施故障已清除");
    const state = engine.readState(instId)!;
    expect(state.paused).toBe(false);
    expect(state.current_phase).toBe("check"); // re-verify, don't re-do the work
    expect(state.fail_count).toBe(1);          // untouched
  });

  it("branch 2: approving a manual gate keeps the done marker so DO is not re-run", async () => {
    const instId = seedInstance();
    engine.writeManualStepMarker(instId);
    engine.writeDoneReported(instId);
    engine.writeManualGate(instId);

    const out = await call("ralphflow_continue");
    expect(out).toContain("审查通过");
    expect(engine.markerExists(".manual-gate", instId)).toBe(false);
    expect(engine.markerExists(".manual-step-active", instId)).toBe(false);
    // The done marker MUST survive: it is what tells the runner to verify
    // instead of re-running the work the user just reviewed.
    expect(engine.doneReported(instId)).toBe(true);
  });

  it("branch 3: resuming a max_failures pause resets the count and re-issues the prompt", async () => {
    const instId = seedInstance({ paused: true, pause_reason: "max_failures", fail_count: 3, last_failure_reason: "tests failed" });
    const out = await call("ralphflow_continue");
    expect(out).toContain("工作流已恢复");
    expect(out).toContain("之前尝试次数：3");
    expect(out).toContain("tests failed");

    const state = engine.readState(instId)!;
    expect(state.paused).toBe(false);
    expect(state.fail_count).toBe(0);
    expect(state.current_phase).toBe("do");
    // The re-issued prompt carries the failure context forward.
    expect(engine.readDoPromptCache(instId)).toContain("tests failed");
  });

  it("branch 4: crash recovery resets a stranded check back to DO", async () => {
    const instId = seedInstance({ current_phase: "check", fail_count: 1 });
    const out = await call("ralphflow_continue");
    expect(out).toContain("崩溃恢复");
    const state = engine.readState(instId)!;
    expect(state.current_phase).toBe("do");
    expect(engine.readDoPromptCache(instId)).toContain("之前的验证被中断");
  });

  it("branch 4: refuses to recover while a check is genuinely running", async () => {
    // hasActiveCheck is false here, so simulate the other side: a live foreign
    // runner must block the takeover entirely.
    const instId = seedInstance({ current_phase: "check" });
    engine.writeMarker(".runner-pid", String(process.ppid), instId);
    const out = await call("ralphflow_continue");
    expect(out).toContain("正被另一个 ralph 进程");
    expect(engine.readState(instId)!.current_phase).toBe("check"); // untouched
  });

  it("branch 5: attaching to an instance interrupted mid-DO re-issues the prompt", async () => {
    const instId = seedInstance({ session_id: "some-other-session", last_failure_reason: "was interrupted" });
    const out = await call("ralphflow_continue");
    expect(out).toContain("已接管工作流实例");
    expect(out).toContain("中断于 DO 阶段");
    expect(engine.readState(instId)!.session_id).toBe(SESSION);
  });

  it("branch 6: nothing to do when the instance is mid-DO and already ours", async () => {
    seedInstance();
    const out = await call("ralphflow_continue");
    expect(out).toContain("没有需要手动继续的操作");
  });

  it("hands the instance to the runner on every branch that leaves it alive", async () => {
    const instId = seedInstance({ paused: true, pause_reason: "max_failures", fail_count: 3 });
    await call("ralphflow_continue");
    expect(driven).toEqual([instId]);
  });

  it("reports when there is nothing to continue", async () => {
    const out = await call("ralphflow_continue");
    expect(out).toContain("没有活跃的工作流");
  });

  it("allows taking over a second instance from one session (one session, several workflows)", async () => {
    seedInstance(); // owned by SESSION
    const other = seedInstance({ session_id: "someone-else" });
    const out = await call("ralphflow_continue", { instance: other });
    expect(out).not.toContain("一个会话同时只能驱动一个实例");
    expect(engine.readState(other)!.session_id).toBe(SESSION);
    const owners = engine.listInstances().map((i) => i.owner);
    expect(owners.every((o) => o === SESSION)).toBe(true);
  });

  it("without an id, refuses to guess which of several owned instances is meant (ambiguous — must be explicit)", async () => {
    const a = seedInstance();
    const b = seedInstance({ session_id: SESSION });
    const out = await call("ralphflow_continue");
    expect(out).toContain("同时驱动着多个实例");
    expect(out).toContain(a);
    expect(out).toContain(b);
    // Neither instance was touched by the ambiguous call.
    expect(engine.readState(a)!.current_phase).toBe("do");
    expect(engine.readState(b)!.current_phase).toBe("do");
  });
});

describe("ralphflow_cancel", () => {
  it("destroys the instance and archives a report", async () => {
    const instId = seedInstance();
    const out = await call("ralphflow_cancel");
    expect(out).toContain("已取消");
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
    expect(fs.readdirSync(engine.getReportsDir()).some((f) => f.startsWith(instId))).toBe(true);
  });

  it("without an id, refuses to guess which of several owned instances to destroy (never guess on a destructive action)", async () => {
    const a = seedInstance();
    const b = seedInstance({ session_id: SESSION });
    const out = await call("ralphflow_cancel");
    expect(out).toContain("同时驱动着多个实例");
    // Neither instance was actually destroyed by the ambiguous call.
    expect(fs.existsSync(engine.getInstanceDir(a))).toBe(true);
    expect(fs.existsSync(engine.getInstanceDir(b))).toBe(true);
  });

  it("warns when another live process is driving the instance", async () => {
    const instId = seedInstance();
    engine.writeMarker(".runner-pid", String(process.ppid), instId);
    const out = await call("ralphflow_cancel");
    expect(out).toContain("已取消");
    expect(out).toContain(`pid ${process.ppid}`);
  });

  it("warns when the instance belongs to another session", async () => {
    seedInstance({ session_id: "other-session" });
    const out = await call("ralphflow_cancel");
    expect(out).toContain("属主是另一个会话");
  });
});

describe("ralphflow_status", () => {
  it("details this session's instance", async () => {
    seedInstance({ fail_count: 2, last_failure_reason: "nope" });
    const out = await call("ralphflow_status");
    expect(out).toContain("## 工作流状态");
    expect(out).toContain("🟢 本会话");
    expect(out).toContain("**失败次数**: 2");
    expect(out).toContain("nope");
    expect(out).toContain("## 当前步骤详情");
    expect(out).toContain("do one");
  });

  it("flags a waiting manual gate", async () => {
    const instId = seedInstance();
    engine.writeManualGate(instId);
    const out = await call("ralphflow_status");
    expect(out).toContain("等待手动审查");
  });

  it("lists everything when several instances exist and none is asked for", async () => {
    seedInstance({ session_id: "a" });
    seedInstance({ session_id: "b" });
    const out = await call("ralphflow_status");
    expect(out).toContain("工作流实例（2 个）");
  });

  it("resolves a unique prefix", async () => {
    const instId = seedInstance({ session_id: "other" });
    const out = await call("ralphflow_status", { instance: instId.slice(0, instId.length - 2) });
    expect(out).toContain(instId);
  });

  it("says so when there is nothing running", async () => {
    const out = await call("ralphflow_status");
    expect(out).toContain("没有活跃的工作流实例");
  });

  it("always terminates the turn — a real user reported the model chaining a watch call right after reading status, taking over the screen unprompted", async () => {
    // Nothing running: the earliest possible return.
    expect((await callRaw("ralphflow_status")).terminate).toBe(true);

    // Found (this session's own instance).
    seedInstance();
    expect((await callRaw("ralphflow_status")).terminate).toBe(true);

    // Not found (bad id).
    expect((await callRaw("ralphflow_status", { instance: "no-such-id" })).terminate).toBe(true);

    // Ambiguous prefix: a second instance makes the bare call list-everything,
    // and an empty-string instance prefix matches both.
    seedInstance({ session_id: "other" });
    expect((await callRaw("ralphflow_status", { instance: "test-wf" })).terminate).toBe(true);
  });
});

describe("ralphflow_list", () => {
  it("lists workflows and active instances", async () => {
    seedInstance();
    const out = await call("ralphflow_list");
    expect(out).toContain("## 可用工作流");
    expect(out).toContain("test-wf");
    expect(out).toContain("loop");   // built-in
    expect(out).toContain("工作流实例（1 个）");
  });
});

describe("ralphflow_doctor", () => {
  it("returns the diagnosis report", async () => {
    const out = await call("ralphflow_doctor");
    expect(out).toContain("Ralph Flow 工作流诊断");
    expect(out).toContain("test-wf");
  });
});
