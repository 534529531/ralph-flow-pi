/**
 * Runner behavior — the opencode plugin's driver.test.ts scenarios, replayed
 * against the loop that replaced the idle handler.
 *
 * The assertions moved from "which injectPrompt calls happened" to "which
 * followUps happened and what the state file says", because the mechanism
 * changed (see runner.ts). The BEHAVIORS are the same ones, and each is here
 * because getting it wrong has a specific expensive failure:
 *   - burning the keep-alive budget while the model works → abandons a healthy step
 *   - not burning it when the model is stuck → drives a dead session forever
 *   - checking after the manual gate → the review gate is decorative
 *   - applying a stale verdict → drives a workflow someone else cancelled
 *   - infra treated as a work failure → burns the retry budget on an API outage
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import { createRunner, MAX_DO_REINJECT, type RunnerEvents } from "../engine/runner.js";
import { createFakeAdapter, createFakeCheckAdapter, type Turn } from "./fake-adapter.js";

let tmpDir: string;
let engine: Engine;
let INST: string;
let messages: string[];
let events: RunnerEvents;
let gates: string[];
let stalls: Array<{ stepId: string; attempts: number }>;
let paused: string[];
let completed: string[];

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

function startInstance(wfName = "test-wf", task = "test task"): string {
  const wf = engine.loadWorkflow(wfName)!;
  const instId = engine.generateInstanceId(wfName);
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, task);
  engine.writeState({
    active: true, workflow_name: wfName, current_step: wf.steps[0].id, current_phase: "do",
    fail_count: 0, user_task: task, paused: false, session_id: "sess-1",
  }, instId);
  if (wf.manual_step.includes(wf.steps[0].id)) engine.writeManualStepMarker(instId);
  INST = instId;
  return instId;
}

/** Build a runner wired to scripted DO turns and scripted check verdicts. */
function makeRunner(opts: {
  turns?: Turn[];
  turnsPerSession?: Turn[][];
  verdicts?: Array<{ pass: boolean; reason?: string } | "silent">;
  createThrowsOnSession?: { n: number; message: string };
}) {
  const doAdapter = createFakeAdapter({
    turns: opts.turns,
    turnsPerSession: opts.turnsPerSession,
    createThrowsOnSession: opts.createThrowsOnSession,
  });
  const checkAdapter = createFakeCheckAdapter(opts.verdicts ?? [{ pass: true, reason: "ok" }]);
  const runner = createRunner(engine, events, {
    createSession: doAdapter.createSession,
    checkDeps: { createSession: checkAdapter.createSession },
  });
  return { runner, doAdapter, checkAdapter };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-runner-test-"));
  engine = createEngine(tmpDir, {}) as Engine;
  messages = [];
  gates = [];
  stalls = [];
  paused = [];
  completed = [];
  events = {
    onMessage: (_i, text) => messages.push(text),
    onGate: (_i, stepId) => gates.push(stepId),
    onStalled: (_i, stepId, attempts) => stalls.push({ stepId, attempts }),
    onPaused: (i) => paused.push(i),
    onCompleted: (i) => completed.push(i),
  };
  writeWorkflow("test-wf", SIMPLE_WF);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const allMessages = () => messages.join("\n---\n");

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("full run", () => {
  it("runs both steps and completes, destroying the instance", async () => {
    startInstance();
    const { runner } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true, reason: "looks good" }] });
    runner.ensureRunning(INST);
    await runner.idle();

    expect(completed).toEqual([INST]);
    expect(fs.existsSync(engine.getInstanceDir(INST))).toBe(false);
    expect(allMessages()).toContain("工作流完成");
    const reports = fs.readdirSync(engine.getReportsDir());
    expect(reports.some((f) => f.startsWith(INST))).toBe(true);
  });

  it("stays silent in chat for every intermediate step, speaking up only for the final outcome", async () => {
    // "runs in the background, tells you when it needs you" — a two-step run
    // that never pauses/gates should produce exactly one chat message (the
    // terminal one), not a running commentary on step 1 passing, step 2
    // starting, etc. This is what makes detaching (Esc) trustworthy: the main
    // agent has nothing to react to until there's actually something to say.
    startInstance();
    const { runner } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true, reason: "looks good" }] });
    runner.ensureRunning(INST);
    await runner.idle();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("工作流完成");
  });

  it("gives every step its own session — the whole point of the rewrite", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true }] });
    runner.ensureRunning(INST);
    await runner.idle();

    // Two steps → two DO sessions → two distinct transcript dirs.
    expect(doAdapter.sessions.length).toBe(2);
    expect(doAdapter.sessions[0].sessionDir).toContain("one-do-1");
    expect(doAdapter.sessions[1].sessionDir).toContain("two-do-1");
    expect(doAdapter.sessions[0].sessionDir).not.toBe(doAdapter.sessions[1].sessionDir);
  });

  it("injects report_done into the DO session", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true }] });
    runner.ensureRunning(INST);
    await runner.idle();

    expect(doAdapter.sessions[0].toolNames).toContain("report_done");
    expect(doAdapter.sessions[0].prompts[0]).toContain("do one");
    // CHECK starting is not a "needs you" moment — it's silent in chat (the
    // run view, if attached, shows it live via onStepStart instead).
    expect(allMessages()).not.toContain("CHECK 阶段");
  });
});

// ─── Keep-alive budget (driver.ts's reinjection semantics) ───────────────────

describe("keep-alive", () => {
  it("nudges a silent model and stops after MAX_DO_REINJECT without pausing", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({ turns: [{ text: "thinking..." }] }); // never calls report_done
    runner.ensureRunning(INST);
    await runner.idle();

    expect(stalls.length).toBe(1);
    expect(stalls[0].attempts).toBe(MAX_DO_REINJECT + 1);
    expect(doAdapter.sessions[0].followUps.length).toBe(MAX_DO_REINJECT);
    expect(allMessages()).toContain("已停止自动驱动");

    // Deliberately NOT paused: the workflow is fine, the model is stuck.
    const state = engine.readState(INST)!;
    expect(state.paused).toBe(false);
    expect(state.current_phase).toBe("do");
  });

  it("does not burn the budget while the model is calling tools", async () => {
    startInstance();
    // Works (tool calls) for many turns, then finishes. If tool activity burned
    // the budget this would stall before ever reaching report_done.
    const turns: Turn[] = [
      ...Array(12).fill({ toolCalls: [{ name: "some_tool" }] }),
      { done: true },
    ];
    const { runner } = makeRunner({ turnsPerSession: [turns, [{ done: true }]], verdicts: [{ pass: true }] });
    runner.ensureRunning(INST);
    await runner.idle();

    expect(stalls).toEqual([]);
    expect(completed).toEqual([INST]);
  });

  it("keeps the budget per step:phase, so a new step starts fresh", async () => {
    startInstance();
    const { runner } = makeRunner({
      // Step one: 3 silent turns then done. Step two: done immediately.
      turnsPerSession: [[{ text: "..." }, { text: "..." }, { text: "..." }, { done: true }], [{ done: true }]],
      verdicts: [{ pass: true }],
    });
    runner.ensureRunning(INST);
    await runner.idle();
    expect(stalls).toEqual([]);
    expect(completed).toEqual([INST]);
  });
});

// ─── Live steering (run-view's persistent input, see tui/run-view.ts) ────────

describe("live steering", () => {
  it("steers the active DO session while it is running and returns true", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({ turns: [{ hangs: true }] });
    runner.ensureRunning(INST);
    await new Promise((r) => setTimeout(r, 20)); // let the loop reach the hung prompt

    const ok = runner.sendUserMessage(INST, "看这里，先别用这个方案");
    expect(ok).toBe(true);
    expect(doAdapter.sessions[0].steers).toEqual(["看这里，先别用这个方案"]);

    runner.pauseAllForShutdown();
  });

  it("returns false when there is no active session (before start / after check / paused / stalled)", async () => {
    startInstance();
    const { runner } = makeRunner({ turns: [{ done: true }] });
    // No session has been created yet — nothing to steer into.
    expect(runner.sendUserMessage(INST, "hi")).toBe(false);
  });

  it("ignores a blank message", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({ turns: [{ hangs: true }] });
    runner.ensureRunning(INST);
    await new Promise((r) => setTimeout(r, 20));

    expect(runner.sendUserMessage(INST, "   ")).toBe(false);
    expect(doAdapter.sessions[0].steers).toEqual([]);

    runner.pauseAllForShutdown();
  });

  it("a steer replaces the generic nudge on the very next cycle, instead of stacking behind it", async () => {
    startInstance();
    // turn0 = initial prompt. turn1's onStart steers deterministically the
    // instant it starts playing (i.e. while it is the in-flight followUp) —
    // this fires before the LOOP has re-read the flag for the cycle that
    // sends turn1's own nudge, so it can only affect the nudge that leads
    // into turn2. That's exactly the boundary this test pins: iteration 2's
    // nudge must be the steered acknowledgement, not the boilerplate "继续
    // 执行步骤..." text that would otherwise stack right behind a real human
    // message.
    let runnerRef!: ReturnType<typeof makeRunner>["runner"];
    const turns: Turn[] = [
      { text: "turn0" },
      { text: "turn1", onStart: () => runnerRef.sendUserMessage(INST, "补充信息在 spec.md 里") },
      { done: true },
    ];
    const { runner, doAdapter } = makeRunner({ turns });
    runnerRef = runner;
    runner.ensureRunning(INST);
    await runner.idle();

    const followUps = doAdapter.sessions[0].followUps;
    expect(followUps.length).toBe(2);
    expect(followUps[0]).toContain("继续执行步骤"); // iteration 1: no steer yet, generic nudge
    expect(followUps[1]).not.toContain("继续执行步骤"); // iteration 2: steered, no boilerplate stacked on top
    expect(followUps[1]).toContain("已收到你的补充说明");
  });

  it("after a stall, ensureRunning drives the same step to completion (the run-view /ralphflow-continue path)", async () => {
    startInstance();
    // Repeats the silent turn forever until swapped — simulate that by using
    // turnsPerSession: session 1 (this step's first attempt) stalls; if the
    // loop is asked to run again on the SAME instance, a fresh runDoPhase
    // call creates a NEW session per pickAttemptDir (no failure context yet,
    // since a stall never set last_failure_reason), so session 2 gets its
    // own turns and can actually finish.
    const { runner, doAdapter } = makeRunner({
      turnsPerSession: [[{ text: "..." }], [{ done: true }], [{ done: true }]],
      verdicts: [{ pass: true }],
    });
    runner.ensureRunning(INST);
    await runner.idle();
    expect(stalls.length).toBe(1);
    expect(runner.isRunning(INST)).toBe(false); // the loop exited on its own

    // This is what run-app.ts's continueInstance does for a stalled resume:
    // clear the budget and ask the runner to drive again.
    runner.ensureRunning(INST);
    await runner.idle();

    expect(completed).toEqual([INST]);
    expect(doAdapter.sessions.length).toBe(3); // stalled attempt + two real steps
  });
});

// ─── Manual gate ─────────────────────────────────────────────────────────────

describe("manual gate", () => {
  const MANUAL_WF = SIMPLE_WF.replace("description: test workflow", "description: test workflow\nmanual_step: [one]");

  it("stops after DO for review and does NOT run the check", async () => {
    writeWorkflow("manual-wf", MANUAL_WF);
    startInstance("manual-wf");
    const { runner, checkAdapter } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true }] });
    runner.ensureRunning(INST);
    await runner.idle();

    expect(gates).toEqual(["one"]);
    expect(checkAdapter.count).toBe(0); // the gate is real: no verification yet
    expect(allMessages()).toContain("等待你的审查");
    expect(engine.markerExists(".manual-gate", INST)).toBe(true);
    expect(engine.readState(INST)!.current_phase).toBe("do");
  });

  it("approving the gate runs the check without re-running DO", async () => {
    writeWorkflow("manual-wf", MANUAL_WF);
    startInstance("manual-wf");
    const { runner, doAdapter, checkAdapter } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true }] });
    runner.ensureRunning(INST);
    await runner.idle();
    const sessionsAfterGate = doAdapter.sessions.length;

    // What ralphflow_continue does for an armed gate: clear it and re-enter.
    engine.clearManualGate(INST);
    runner.ensureRunning(INST);
    await runner.idle();

    expect(checkAdapter.count).toBeGreaterThan(0);
    // Step one's DO was not replayed — .done-reported short-circuits it.
    expect(doAdapter.sessions.length).toBeGreaterThan(sessionsAfterGate);
    expect(doAdapter.sessions[0].prompts.length).toBe(1);
  });

  it("requesting changes re-runs DO with the instruction and re-arms the gate", async () => {
    writeWorkflow("manual-wf", MANUAL_WF);
    startInstance("manual-wf");
    // First DO reports done → gate. After revision, DO reports done again → gate again.
    const { runner, doAdapter, checkAdapter } = makeRunner({
      turnsPerSession: [[{ done: true }], [{ done: true }]],
      verdicts: [{ pass: true }],
    });
    runner.ensureRunning(INST);
    await runner.idle();
    expect(gates).toEqual(["one"]);
    const sessionsAtGate = doAdapter.sessions.length;

    // The user asks for a change at the gate.
    runner.reviseGate(INST, "把标题改成中文");
    await runner.idle();

    // DO ran again (a new session/turn), the instruction was delivered, and the
    // gate re-armed — verification did NOT run yet.
    expect(doAdapter.sessions.length).toBeGreaterThan(sessionsAtGate);
    const lastDo = doAdapter.sessions[doAdapter.sessions.length - 1];
    expect(lastDo.prompts.join("\n")).toContain("把标题改成中文");
    expect(checkAdapter.count).toBe(0);   // still gated, not verified
    expect(gates).toEqual(["one", "one"]); // re-armed
    expect(engine.markerExists(".manual-gate", INST)).toBe(true);
  });
});

// ─── Check verdict handling ──────────────────────────────────────────────────

describe("check verdicts", () => {
  it("a failed check retries the same step, resuming its session with the reason", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({
      turns: [{ done: true }],
      verdicts: [{ pass: false, reason: "缺少 out1.md" }, { pass: true, reason: "ok" }, { pass: true }],
    });
    runner.ensureRunning(INST);
    await runner.idle();

    // A retry within budget doesn't need the user, so it stays out of chat —
    // only the eventual terminal outcome (completed, here) reaches it.
    expect(allMessages()).not.toContain("失败 ✗ (1/3)");
    expect(allMessages()).not.toContain("缺少 out1.md");
    // The retry resumed the SAME attempt dir: a fix needs to know what it tried.
    const oneDoDirs = doAdapter.sessions.filter((s) => s.sessionDir?.includes("one-do-"));
    expect(oneDoDirs.length).toBe(2);
    expect(oneDoDirs[0].sessionDir).toBe(oneDoDirs[1].sessionDir);
    expect(completed).toEqual([INST]);
  });

  it("pauses at max_failures", async () => {
    startInstance();
    const { runner } = makeRunner({
      turns: [{ done: true }],
      verdicts: [{ pass: false, reason: "still broken" }], // fails forever; max_fail_count is 3
    });
    runner.ensureRunning(INST);
    await runner.idle();

    const state = engine.readState(INST)!;
    expect(state.paused).toBe(true);
    expect(state.pause_reason).toBe("max_failures");
    expect(state.fail_count).toBe(3);
    expect(paused).toContain(INST);
    expect(allMessages()).toContain("已达最大失败次数");
  });

  it("an infra failure pauses with check_error and burns NO fail count", async () => {
    startInstance();
    const { runner } = makeRunner({ turns: [{ done: true }], verdicts: ["silent"] }); // no verdict → infra
    runner.ensureRunning(INST);
    await runner.idle();

    const state = engine.readState(INST)!;
    expect(state.paused).toBe(true);
    expect(state.pause_reason).toBe("check_error");
    expect(state.fail_count).toBe(0); // the work was fine; the verifier wasn't
    expect(allMessages()).toContain("验证未能运行");
    expect(allMessages()).toContain("不计入失败次数");
  });

  it("resuming a check_error re-verifies without re-running DO", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({ turns: [{ done: true }], verdicts: ["silent", { pass: true }, { pass: true }] });
    runner.ensureRunning(INST);
    await runner.idle();
    expect(engine.readState(INST)!.pause_reason).toBe("check_error");
    const sessionsBefore = doAdapter.sessions.length;

    // What ralphflow_continue does for a check_error pause.
    engine.writeState({ ...engine.readState(INST)!, paused: false, pause_reason: undefined }, INST);
    runner.ensureRunning(INST);
    await runner.idle();

    expect(completed).toEqual([INST]);
    // Step one's DO never re-ran: the state was in "check", so the loop verified.
    expect(doAdapter.sessions.filter((s) => s.sessionDir?.includes("one-do-")).length)
      .toBe(doAdapter.sessions.slice(0, sessionsBefore).filter((s) => s.sessionDir?.includes("one-do-")).length);
  });

  it("discards a verdict when the instance was cancelled mid-check", async () => {
    startInstance();
    const instId = INST;
    // Cancel while the check is in flight.
    const checkAdapter = {
      createSession: async (opts: any) => {
        const tools = opts.customTools ?? [];
        return {
          jsonlPath: "/tmp/fake.jsonl",
          async prompt() {
            engine.destroyInstance(instId, "cancelled");
            const verdict = tools.find((t: any) => t.name === "verdict");
            await (verdict as any)?.execute("v", { pass: true, reason: "too late" }, undefined, undefined, {});
          },
          async followUp() {}, async steer() {},
          subscribe: () => () => {}, async abort() {}, dispose() {},
        } as any;
      },
    };
    const doAdapter = createFakeAdapter({ turns: [{ done: true }] });
    const runner = createRunner(engine, events, { createSession: doAdapter.createSession, checkDeps: checkAdapter });
    runner.ensureRunning(instId);
    await runner.idle();

    // The instance is gone; the pass verdict must not have resurrected it.
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
    expect(completed).toEqual([]);
    expect(allMessages()).not.toContain("工作流完成");
  });
});

// ─── Config errors ───────────────────────────────────────────────────────────

describe("config errors", () => {
  it("pauses when the workflow YAML vanishes mid-run", async () => {
    startInstance();
    fs.rmSync(path.join(tmpDir, ".ralph-flow", "workflows", "test-wf.yaml"));
    const { runner } = makeRunner({ turns: [{ done: true }] });
    runner.ensureRunning(INST);
    await runner.idle();

    const state = engine.readState(INST)!;
    expect(state.paused).toBe(true);
    expect(state.pause_reason).toBe("config_error");
    expect(state.last_failure_reason).toContain("未找到");
  });

  it("pauses when the current step is removed from the YAML", async () => {
    startInstance();
    writeWorkflow("test-wf", SIMPLE_WF.replace(/  - id: one[\s\S]*?max_fail_count: 3\n/, ""));
    const { runner } = makeRunner({ turns: [{ done: true }] });
    runner.ensureRunning(INST);
    await runner.idle();
    expect(engine.readState(INST)!.pause_reason).toBe("config_error");
  });

  it("pauses when the step session cannot be created", async () => {
    startInstance();
    const { runner } = makeRunner({ createThrowsOnSession: { n: 1, message: "no API key" } });
    runner.ensureRunning(INST);
    await runner.idle();
    const state = engine.readState(INST)!;
    expect(state.paused).toBe(true);
    expect(state.last_failure_reason).toContain("no API key");
  });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

// ─── Multi-listener broadcast (chat's permanent listener + a run view's temporary one) ─

describe("addEventListener", () => {
  it("fans the same events out to every registered listener, including the constructor's own", async () => {
    startInstance();
    const { runner } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true }] });
    const extra: string[] = [];
    runner.addEventListener({ onStepStart: (_i, sid, phase) => extra.push(`${sid}:${phase}`) });
    runner.ensureRunning(INST);
    await runner.idle();

    // `events` (constructor-supplied) already collects into `gates`/`stalls`/
    // `paused`/`completed`/`messages` via the shared beforeEach setup — the
    // extra listener registered above must see the same step starts (do AND
    // check phase each, for both steps).
    expect(extra).toEqual(["one:do", "one:check", "two:do", "two:check"]);
    expect(completed).toEqual([INST]); // the constructor listener still fired too
  });

  it("stops receiving events once the returned unsubscribe function is called", async () => {
    startInstance("test-wf", "task");
    // onStart fires synchronously the instant step "one"'s only DO turn
    // begins playing — deterministic removal timing, no racing real timers
    // (see fake-adapter.ts's Turn.onStart).
    let removeRef: (() => void) | undefined;
    const { runner } = makeRunner({
      turnsPerSession: [[{ done: true, onStart: () => removeRef?.() }], [{ done: true }]],
      verdicts: [{ pass: true }],
    });
    const extra: string[] = [];
    removeRef = runner.addEventListener({ onStepStart: (_i, sid, phase) => extra.push(`${sid}:${phase}`) });
    runner.ensureRunning(INST);
    await runner.idle();

    // Saw step "one" DO start (fired before its turn even played, so before
    // removal) but nothing from then on — while the constructor listener
    // (unaffected) saw the whole run finish.
    expect(extra).toEqual(["one:do"]);
    expect(completed).toEqual([INST]);
  });
});

describe("lifecycle", () => {
  it("one loop per instance (ensureRunning is idempotent)", async () => {
    startInstance();
    const { runner, doAdapter } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true }] });
    runner.ensureRunning(INST);
    runner.ensureRunning(INST);
    runner.ensureRunning(INST);
    await runner.idle();
    expect(doAdapter.sessions.length).toBe(2); // two steps, not six
  });

  it("writes a runner pid while driving and clears it after", async () => {
    startInstance();
    const { runner } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: false, reason: "x" }] });
    runner.ensureRunning(INST);
    await runner.idle();
    // Instance still exists (paused or retrying) → pid cleared on loop exit.
    if (engine.instanceExists(INST)) expect(engine.readRunnerPid(INST)).toBeNull();
  });

  it("a paused instance is not driven", async () => {
    startInstance();
    engine.writeState({ ...engine.readState(INST)!, paused: true, pause_reason: "max_failures" }, INST);
    const { runner, doAdapter } = makeRunner({ turns: [{ done: true }] });
    runner.ensureRunning(INST);
    await runner.idle();
    expect(doAdapter.sessions.length).toBe(0);
    expect(paused).toContain(INST);
  });

  it("shutdown pauses in-flight instances as session_aborted", async () => {
    startInstance();
    const { runner } = makeRunner({ turns: [{ hangs: true }] });
    runner.ensureRunning(INST);
    await new Promise((r) => setTimeout(r, 20)); // let the loop reach the hung prompt
    runner.pauseAllForShutdown();

    const state = engine.readState(INST)!;
    expect(state.paused).toBe(true);
    expect(state.pause_reason).toBe("session_aborted");
    // The transcript is on disk, so continue resumes this very step session.
    expect(state.current_step).toBe("one");
  });
});

// ─── Sub-workflows ───────────────────────────────────────────────────────────

describe("sub-workflows", () => {
  beforeEach(() => {
    writeWorkflow("child", `
steps:
  - id: c1
    desc: child step
    do: child work
    check: child check
    input: i
    output: o
    on_pass: done
    on_fail: c1
    max_fail_count: 2
`);
    writeWorkflow("parent", `
steps:
  - id: p1
    desc: parent first
    do: parent work
    check: parent check
    input: i
    output: o
    on_pass: p2
    on_fail: p1
    max_fail_count: 2
  - id: p2
    desc: delegate
    workflow: child
    inputs:
      hint: from parent
    input: i
    output: o
    on_pass: done
    on_fail: p2
    max_fail_count: 2
`);
  });

  it("runs through a sub-workflow to completion", async () => {
    startInstance("parent");
    const { runner, doAdapter } = makeRunner({ turns: [{ done: true }], verdicts: [{ pass: true, reason: "ok" }] });
    runner.ensureRunning(INST);
    await runner.idle();

    // Entering the sub-workflow is an ordinary silent transition, not a
    // "needs you" moment, so it stays out of chat — only the final terminal
    // message (which happens to embed the sub-workflow's own completion,
    // since that's the same transition that finishes the whole run) reaches it.
    expect(allMessages()).not.toContain("进入子工作流");
    expect(allMessages()).toContain('子工作流 "child" 已完成');
    expect(completed).toEqual([INST]);
    // p1 and the child's c1 each got their own session.
    expect(doAdapter.sessions.some((s) => s.sessionDir?.includes("p1-do-"))).toBe(true);
    expect(doAdapter.sessions.some((s) => s.sessionDir?.includes("c1-do-"))).toBe(true);
  });
});
