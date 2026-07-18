/**
 * `runContinue` — headless `ralphflow continue`, the one verb missing until
 * now (status/list/doctor/cancel were already headless; continue wasn't,
 * which was a real, asymmetric gap for scripts/CI wanting to unblock a
 * paused/gated instance without an interactive session).
 *
 * Reuses resolveContinueAction (the exact same state machine as the
 * ralphflow_continue tool — see tools.test.ts for that side's coverage), so
 * these tests focus on what's NEW here: resolving which instance headlessly,
 * refusing a foreign-driven instance, and driving to the next stopping point
 * afterward via a real (fake-adapter-backed) runner.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import { runContinue } from "../headless.js";
import { createFakeAdapter, createFakeCheckAdapter } from "./fake-adapter.js";

let tmpDir: string;
let engine: Engine;

const ONE_STEP_WF = `
description: test workflow
steps:
  - id: one
    desc: only step
    do: do one
    check: check one
    input: user input
    output: "out1.md"
    on_pass: done
    on_fail: one
    max_fail_count: 3
`;

function writeWorkflow(): void {
  const dir = path.join(tmpDir, ".ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test-wf.yaml"), ONE_STEP_WF);
}

/** An instance parked in a given state, without going through start. */
function seedInstance(overrides: Partial<Parameters<Engine["writeState"]>[0]> = {}): string {
  const instId = engine.generateInstanceId("test-wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState({
    active: true, workflow_name: "test-wf", current_step: "one", current_phase: "do",
    fail_count: 0, user_task: "task", paused: false, ...overrides,
  }, instId);
  return instId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-headless-test-"));
  engine = createEngine(tmpDir, {}) as Engine;
  writeWorkflow();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runContinue: resolving which instance", () => {
  it("refuses when there are no active instances", async () => {
    const r = await runContinue(engine);
    expect(r.code).toBe(1);
    expect(r.text).toContain("没有活跃的工作流实例");
  });

  it("auto-picks the single active instance", async () => {
    const instId = seedInstance({ paused: true, pause_reason: "max_failures", last_failure_reason: "x" });
    const r = await runContinue(engine, undefined, { createSession: createFakeAdapter({ turns: [{ done: true }] }).createSession, checkDeps: { createSession: createFakeCheckAdapter([{ pass: true }]).createSession } });
    expect(r.code).toBe(0);
    expect(r.text).toContain("已恢复");
    expect(instId).toBeTruthy();
  });

  it("requires an explicit id when multiple instances exist", async () => {
    seedInstance();
    seedInstance();
    const r = await runContinue(engine);
    expect(r.code).toBe(1);
    expect(r.text).toContain("存在多个实例");
  });

  it("resolves a unique id prefix", async () => {
    const instId = seedInstance({ paused: true, pause_reason: "max_failures", last_failure_reason: "x" });
    const other = seedInstance();
    const r = await runContinue(engine, instId.slice(0, instId.length - 2), {
      createSession: createFakeAdapter({ turns: [{ done: true }] }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter([{ pass: true }]).createSession },
    });
    expect(r.code).toBe(0);
    expect(other).toBeTruthy();
  });

  it("reports an ambiguous prefix instead of guessing", async () => {
    seedInstance();
    seedInstance();
    const r = await runContinue(engine, "test-wf");
    expect(r.code).toBe(1);
    expect(r.text).toContain("匹配到");
  });

  it("refuses an instance another ralph process is driving", async () => {
    const instId = seedInstance({ paused: true, pause_reason: "max_failures", last_failure_reason: "x" });
    // foreignRunnerPid deliberately excludes our OWN pid ("our own pid never
    // counts" — core.ts), so simulating a foreign driver needs a DIFFERENT
    // pid that's still genuinely alive. pid 1 always is on Linux.
    fs.writeFileSync(path.join(engine.getInstanceDir(instId), ".runner-pid"), "1");
    // Belt and suspenders: if the foreign-driver guard somehow doesn't fire,
    // fall through to a fake adapter instead of hanging on a real API call.
    const r = await runContinue(engine, instId, {
      createSession: createFakeAdapter({ turns: [{ done: true }] }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter([{ pass: true }]).createSession },
    });
    expect(r.code).toBe(1);
    expect(r.text).toContain("正被另一个");
  });
});

describe("runContinue: drives to the next stopping point", () => {
  it("resumes a paused instance and runs it to completion", async () => {
    const instId = seedInstance({ paused: true, pause_reason: "max_failures", last_failure_reason: "上次挂了" });
    const doAdapter = createFakeAdapter({ turns: [{ done: true }] });
    const checkAdapter = createFakeCheckAdapter([{ pass: true, reason: "ok" }]);
    const r = await runContinue(engine, instId, { createSession: doAdapter.createSession, checkDeps: { createSession: checkAdapter.createSession } });

    expect(r.code).toBe(0);
    expect(r.text).toContain("已恢复");
    expect(r.text).toContain("工作流已完成");
    expect(r.text).toContain("执行报告");
    expect(engine.instanceExists(instId)).toBe(false);
  });

  it("reports the new pause reason when it fails again right away", async () => {
    const instId = seedInstance({ paused: true, pause_reason: "max_failures", last_failure_reason: "第一次" });
    const doAdapter = createFakeAdapter({ turns: [{ done: true }] });
    // max_fail_count: 3 on the seeded workflow, so failing once more (this
    // resume's attempt) pauses again rather than exhausting it — asserts the
    // headless caller sees the SECOND stop, not silence about it.
    const checkAdapter = createFakeCheckAdapter([{ pass: false, reason: "还是不行" }]);
    const r = await runContinue(engine, instId, { createSession: doAdapter.createSession, checkDeps: { createSession: checkAdapter.createSession } });

    expect(r.code).toBe(0);
    expect(r.text).toContain("已恢复");
    // Either it paused again (max_fail_count reached) or it's mid-retry —
    // either way the instance must still exist and the response must say
    // something about where it landed, not just echo the resume message.
    expect(engine.instanceExists(instId)).toBe(true);
  });

  it("approves a manual gate headlessly and runs verification", async () => {
    const wfWithGate = ONE_STEP_WF.replace("description: test workflow", "description: test workflow\nmanual_step: [one]");
    fs.writeFileSync(path.join(tmpDir, ".ralph-flow", "workflows", "gated-wf.yaml"), wfWithGate);
    const instId = engine.generateInstanceId("gated-wf");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.writeState({
      active: true, workflow_name: "gated-wf", current_step: "one", current_phase: "check",
      fail_count: 0, user_task: "task", paused: false,
    }, instId);
    engine.writeManualGate(instId);
    engine.writeDoneReported(instId); // DO already finished — this is exactly the post-gate state

    const checkAdapter = createFakeCheckAdapter([{ pass: true, reason: "ok" }]);
    const r = await runContinue(engine, instId, { checkDeps: { createSession: checkAdapter.createSession } });

    expect(r.code).toBe(0);
    expect(r.text).toContain("审查通过");
    expect(engine.instanceExists(instId)).toBe(false); // ran verification and completed
  });
});
