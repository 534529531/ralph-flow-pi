/**
 * dispatchInput — the single rule that turns whatever the user submits in the
 * run view's persistent input into an engine action. This is the whole point
 * of unifying gate/pause/stalled into the same input as live DO steering: one
 * function, one rule, testable without a terminal.
 *
 * Rule: `/`-commands always control the state machine (/ralphflow-continue,
 * /ralphflow-cancel — same names the chat surface already uses). Anything
 * else always talks to the work, interpreted per the current status.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { dispatchInput, type RunViewActions } from "../tui/run-view.js";
import { initRunModel, type RunModel, type RunStatus } from "../tui/run-model.js";
import type { WorkflowDef } from "../engine/types.js";

const WF: WorkflowDef = {
  name: "spec",
  description: "spec workflow",
  manual_step: [],
  steps: [
    { id: "propose", desc: "需求分析", do: "d", check: "c", input: "i", output: "o", on_pass: "impl", on_fail: "propose", max_fail_count: 3 },
  ],
};

function model(status: RunStatus, activePhase: "do" | "check" | null): RunModel {
  const m = initRunModel("spec-1", WF, "task");
  m.status = status;
  m.activePhase = activePhase;
  return m;
}

let calls: string[];
let actions: RunViewActions;

beforeEach(() => {
  calls = [];
  actions = {
    approveGate: () => calls.push("approveGate"),
    reviseGate: (t) => calls.push(`reviseGate:${t}`),
    resume: () => calls.push("resume"),
    cancel: () => calls.push("cancel"),
    sendMessage: (t) => calls.push(`sendMessage:${t}`),
    attachNote: (t) => calls.push(`attachNote:${t}`),
  };
});

describe("commands — always control the state machine", () => {
  it("/ralphflow-continue approves a gate", () => {
    dispatchInput("/ralphflow-continue", model("gate", null), actions);
    expect(calls).toEqual(["approveGate"]);
  });

  it("/continue (shorthand) approves a gate", () => {
    dispatchInput("/continue", model("gate", null), actions);
    expect(calls).toEqual(["approveGate"]);
  });

  it("/ralphflow-continue resumes a paused instance", () => {
    dispatchInput("/ralphflow-continue", model("paused", null), actions);
    expect(calls).toEqual(["resume"]);
  });

  it("/ralphflow-continue resumes a stalled instance", () => {
    dispatchInput("/ralphflow-continue", model("stalled", null), actions);
    expect(calls).toEqual(["resume"]);
  });

  it("/ralphflow-continue while running is a no-op — nothing to approve or resume", () => {
    dispatchInput("/ralphflow-continue", model("running", "do"), actions);
    expect(calls).toEqual([]);
  });

  it("/ralphflow-cancel cancels from any non-terminal status", () => {
    for (const status of ["running", "gate", "paused", "stalled"] as const) {
      calls = [];
      dispatchInput("/ralphflow-cancel", model(status, "do"), actions);
      expect(calls).toEqual(["cancel"]);
    }
  });

  it("/cancel (shorthand) cancels", () => {
    dispatchInput("/cancel", model("gate", null), actions);
    expect(calls).toEqual(["cancel"]);
  });

  it("/ralphflow-cancel does nothing once the run has ended", () => {
    for (const status of ["completed", "cancelled"] as const) {
      calls = [];
      dispatchInput("/ralphflow-cancel", model(status, null), actions);
      expect(calls).toEqual([]);
    }
  });

  it("an unrecognized command is ignored rather than misfiring", () => {
    dispatchInput("/ralphflow-status", model("gate", null), actions);
    expect(calls).toEqual([]);
  });
});

describe("plain text — always talks to the work, contextualized by status", () => {
  it("running + do → steers the live session", () => {
    dispatchInput("先别用这个方案", model("running", "do"), actions);
    expect(calls).toEqual(["sendMessage:先别用这个方案"]);
  });

  it("running + check → no-op (CHECK is read-only, independent verification)", () => {
    dispatchInput("这样对吗", model("running", "check"), actions);
    expect(calls).toEqual([]);
  });

  it("gate → revises instead of approving", () => {
    dispatchInput("这里改一下", model("gate", null), actions);
    expect(calls).toEqual(["reviseGate:这里改一下"]);
  });

  it("paused → attaches a note, does NOT resume by itself", () => {
    dispatchInput("已经把 API key 配好了", model("paused", null), actions);
    expect(calls).toEqual(["attachNote:已经把 API key 配好了"]);
  });

  it("stalled → attaches a note, does NOT resume by itself", () => {
    dispatchInput("换个思路，先看看 spec.md", model("stalled", null), actions);
    expect(calls).toEqual(["attachNote:换个思路，先看看 spec.md"]);
  });

  it("blank input is always a no-op", () => {
    for (const status of ["running", "gate", "paused", "stalled"] as const) {
      calls = [];
      dispatchInput("   ", model(status, "do"), actions);
      expect(calls).toEqual([]);
    }
  });
});
