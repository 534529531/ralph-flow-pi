/**
 * The chat surface — `ralphflow`'s default entry point.
 *
 * A general chat, same as talking to Claude Code: starting/watching a workflow
 * is one of the things you can ask it to do (natural language or a
 * /ralphflow-* command), not a separate forced-first mode. When a workflow is
 * actually running, ralphflow_start/continue/watch (commands/tools.ts) borrow
 * this SAME chat session's TUI via Pi's `ctx.ui.custom()` and hand it to the
 * dedicated run view (tui/run-app.ts's runInstanceInTui) for the duration of
 * the run — see tui/embed.ts. Detaching (Esc) hands the terminal straight
 * back to this chat, mid-conversation, workflow still running in the
 * background. Designing a NEW workflow (/ralphflow-create) is also just a
 * conversation in this same surface, seeded with a different opening message.
 *
 * It reuses pi's InteractiveMode with our inline extension (the seven
 * ralphflow_* tools + eight slash commands).
 */

import { createEngine } from "../engine/core.js";
import { abortActiveCheck } from "../engine/check.js";
import { createRalphExtension } from "./extension.js";
import { bootInteractive } from "../pi/interactive.js";

/** Launch the chat surface. `seed`, if given, is sent as the first message. */
export async function runChat(cwd: string, seed?: string): Promise<void> {
  const engine = createEngine(cwd, { abortActiveCheck });
  engine.ensureProjectWorkflows();

  // The main session's id is the ownership token in every instance's state.json.
  // It only exists once pi has built the session, so the extension reads it
  // lazily rather than capturing it at construction.
  let sessionId = "";
  const ralph = createRalphExtension(engine, () => sessionId);

  await bootInteractive({
    cwd,
    extension: ralph.extension,
    initialMessage: seed,
    onSessionId: (id) => { sessionId = id; },
    onShutdown: () => ralph.shutdown(),
  });
}

/**
 * `ralphflow create [描述]` — drop into the chat already pointed at the
 * create flow, so the user lands in a workflow-design conversation.
 */
export async function runCreateMode(cwd: string, description: string): Promise<void> {
  const seed = `我想创建一个新的工作流。${description ? `需求：${description}` : ""}\n\n请用 /ralphflow-create 的流程带我设计：先了解要自动化的流程和人工审查点，再设计步骤图给我看，然后写 YAML 并用 ralphflow_doctor 校验到干净。`;
  await runChat(cwd, seed);
}
