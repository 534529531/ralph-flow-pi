/**
 * Scripted stand-ins for Pi sessions, so the runner's whole state machine can be
 * exercised in CI without credentials or a model.
 *
 * A "turn" is what the model does in response to one prompt/followUp: emit some
 * text, call some tools, maybe call report_done. Tests declare the turns; the
 * fake plays them back in order and repeats the last one forever (which is how
 * "the model never finishes" is expressed).
 */

import type { SessionHandle, StepEvent, StepEventListener, ToolDefinition } from "../pi/adapter.js";

export interface Turn {
  /** Text the model "says" this turn. */
  text?: string;
  /** Tools it calls this turn: name → params. Tool activity protects the keep-alive budget. */
  toolCalls?: Array<{ name: string; params?: unknown }>;
  /** Shorthand for calling report_done. */
  done?: boolean;
  /** Throw from prompt/followUp instead of running the turn. */
  throws?: string;
  /** Never settle (simulates a hung model). */
  hangs?: boolean;
  /**
   * Called synchronously the instant this turn begins playing, before any of
   * its own events. A deterministic hook for tests that need to act at an
   * exact point in the loop (e.g. steer while a specific turn is "in
   * flight") without racing real timers.
   */
  onStart?: () => void;
}

export interface FakeSessionRecord {
  sessionDir?: string;
  prompts: string[];
  followUps: string[];
  steers: string[];
  toolNames: string[];
  aborted: boolean;
  disposed: boolean;
  model?: unknown;
  appendSystemPrompt?: string;
}

export interface FakeAdapterOptions {
  /** Turns for each session, in creation order. A session past the end repeats its last turn. */
  turnsPerSession?: Turn[][];
  /** Turns used by every session (simpler than turnsPerSession when uniform). */
  turns?: Turn[];
  /** Throw on the Nth session creation (1-based). */
  createThrowsOnSession?: { n: number; message: string };
}

export function createFakeAdapter(options: FakeAdapterOptions = {}) {
  const sessions: FakeSessionRecord[] = [];
  let created = 0;

  function turnsFor(index: number): Turn[] {
    if (options.turnsPerSession) return options.turnsPerSession[index] ?? [{}];
    return options.turns ?? [{ done: true }];
  }

  const createSession = async (opts: any): Promise<SessionHandle> => {
    created++;
    if (options.createThrowsOnSession && options.createThrowsOnSession.n === created) {
      throw new Error(options.createThrowsOnSession.message);
    }
    const index = created - 1;
    const tools: ToolDefinition[] = opts.customTools ?? [];
    const record: FakeSessionRecord = {
      sessionDir: opts.sessionDir,
      prompts: [],
      followUps: [],
      steers: [],
      toolNames: tools.map((t) => t.name),
      aborted: false,
      disposed: false,
      model: opts.model,
      appendSystemPrompt: opts.appendSystemPrompt,
    };
    sessions.push(record);

    const listeners: StepEventListener[] = [];
    const emit = (e: StepEvent) => { for (const l of listeners) l(e); };
    const turns = turnsFor(index);
    let turnIndex = 0;

    async function playTurn(): Promise<void> {
      const turn = turns[Math.min(turnIndex, turns.length - 1)] ?? {};
      turnIndex++;
      turn.onStart?.();
      if (turn.hangs) await new Promise(() => {});
      if (turn.throws) throw new Error(turn.throws);
      if (turn.text) emit({ type: "text", delta: turn.text });
      const calls = [...(turn.toolCalls ?? [])];
      if (turn.done) calls.push({ name: "report_done", params: {} });
      for (const call of calls) {
        const tool = tools.find((t) => t.name === call.name);
        emit({ type: "tool_start", toolCallId: `c${turnIndex}`, toolName: call.name, args: call.params });
        let text = "";
        if (tool) {
          const result: any = await (tool as any).execute(`c${turnIndex}`, call.params ?? {}, undefined, undefined, {});
          text = result?.content?.[0]?.text ?? "";
        }
        emit({ type: "tool_end", toolCallId: `c${turnIndex}`, toolName: call.name, isError: !tool, text });
      }
      emit({ type: "turn_end" });
      emit({ type: "agent_end" });
    }

    return {
      jsonlPath: opts.sessionDir ? `${opts.sessionDir}/fake.jsonl` : null,
      async prompt(text: string) { record.prompts.push(text); await playTurn(); },
      async followUp(text: string) { record.followUps.push(text); await playTurn(); },
      async steer(text: string) { record.steers.push(text); },
      subscribe(listener: StepEventListener) {
        listeners.push(listener);
        return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
      },
      async abort() { record.aborted = true; },
      dispose() { record.disposed = true; },
    };
  };

  return { createSession, sessions, get created() { return created; } };
}

/** A check session that submits a fixed verdict. */
export function createFakeCheckAdapter(verdicts: Array<{ pass: boolean; reason?: string } | "silent">) {
  let index = 0;
  const calls: Array<{ pass: boolean; reason?: string } | "silent"> = [];

  const createSession = async (opts: any): Promise<SessionHandle> => {
    const tools: ToolDefinition[] = opts.customTools ?? [];
    const verdict = verdicts[Math.min(index, verdicts.length - 1)] ?? "silent";
    index++;
    calls.push(verdict);
    let submitted = false;

    const submit = async () => {
      if (verdict === "silent" || submitted) return;
      submitted = true;
      const tool = tools.find((t) => t.name === "verdict");
      if (tool) {
        await (tool as any).execute("v1", { pass: verdict.pass, reason: verdict.reason ?? "fake reason" }, undefined, undefined, {});
      }
    };

    return {
      jsonlPath: "/tmp/fake-check.jsonl",
      async prompt() { await submit(); },
      async followUp() { await submit(); },
      async steer() {},
      subscribe() { return () => {}; },
      async abort() {},
      dispose() {},
    };
  };

  return { createSession, calls, get count() { return index; } };
}
