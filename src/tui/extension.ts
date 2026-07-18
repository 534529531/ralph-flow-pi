/**
 * The ralph-flow extension for the main chat session.
 *
 * This is the whole TUI. The plan budgeted ~870 lines for a hand-built one
 * (transcript pane, streaming renderer, slash dispatcher, status bar) — none of
 * that got written, because pi's InteractiveMode already IS a Claude-Code-style
 * TUI and its extension API exposes exactly the three seams we need:
 *
 *   registerTool     → the six ralphflow_* tools, so the model can drive them
 *                      from plain language ("start the spec workflow on X")
 *   registerCommand  → the eight /ralphflow-* slash commands, verbatim
 *   sendMessage      → the runner's output, rendered into the same transcript
 *
 * The important thing this does NOT do: hand pi the workflow. Step sessions are
 * still created and driven by our runner, one fresh context per step. The main
 * chat session is a control surface and a viewport — if it were the DO session
 * we would have rebuilt the opencode plugin's central flaw on a new stack.
 */

import type { Engine } from "../engine/core.js";
import { createRunner, type Runner } from "../engine/runner.js";
import { createTools } from "../commands/tools.js";
import { COMMAND_PROMPTS } from "../commands/prompts.js";
import { loadSkillIndex } from "../engine/skills.js";
import { historyEditorFactory } from "./history-editor.js";
import { createWelcomeHeaderFactory } from "./welcome-header.js";

/**
 * Pi's extension surface, narrowed to what this file touches.
 *
 * Two different objects, easy to conflate (a real crash the first time
 * around): `ExtensionAPI` — this file's `api`, from `factory(api)` — has
 * `registerTool`/`registerCommand`/`sendMessage`/`sendUserMessage`/`on`, and
 * NO `ui`. `ExtensionContext` — a *different* type, handed to every `on(...)`
 * handler and command/tool `execute()` as a context argument — is where `ui`
 * (`.custom`, `.setEditorComponent`, …) actually lives. `ui.custom` (used in
 * tools.ts's attachRunView) is only ever reached via a tool's own `execute()`
 * receiving that context, never via this top-level `api`.
 */
interface PiExtensionApi {
  registerTool(tool: any): void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }): void;
  sendMessage(message: { customType: string; content: string; display?: string; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  on(event: string, handler: (event: any, ctx: ExtensionContextLike) => void): void;
}

/** Just the corner of ExtensionContext (extensions/types.ts) this file needs. */
interface ExtensionContextLike {
  mode: string;
  ui: {
    setEditorComponent(factory: ((tui: any, theme: any, keybindings: any) => unknown) | undefined): void;
    setHeader(factory: ((tui: any, theme: any) => unknown) | undefined): void;
  };
}

export interface RalphExtensionResult {
  runner: Runner;
  /** Called on SIGINT/exit so interrupted instances resume cleanly. */
  shutdown(): void;
}

/**
 * Build the inline extension. `getSessionId` must return the main session's id
 * — it is the ownership token written into every instance's state.json.
 */
export function createRalphExtension(engine: Engine, getSessionId: () => string) {
  let runner: Runner;
  let api: PiExtensionApi;

  /** Post engine-authored text into the transcript without provoking a turn. */
  const post = (text: string) => {
    api.sendMessage({ customType: "ralph-flow", content: text, display: text }, { triggerTurn: false });
  };

  // Pi's InlineExtension shape: { name, factory } — the factory IS the activate
  // hook, called with the extension API.
  const extension = {
    name: "ralph-flow",
    factory(a: PiExtensionApi) {
      api = a;

      // `ui` doesn't exist on `factory`'s own `api` (see the interface
      // comment above) — "session_start" is the first point an
      // ExtensionContext, and therefore `ctx.ui`, is available. `mode ===
      // "tui"` guards it per ExtensionContext.mode's own doc comment ("Use
      // 'tui' to guard terminal-only UI such as custom components") — rpc/
      // print modes have no editor to replace.
      api.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        ctx.ui.setEditorComponent(historyEditorFactory);
        ctx.ui.setHeader(createWelcomeHeaderFactory(() => engine.listWorkflows()));
      });

      // Deliberately NO onStepEvent here: run-app.ts's own temporary listener
      // (added only while a run view is actually attached — see embed.ts)
      // already shows every DO/CHECK tool call live for anyone watching. A
      // permanent listener that also streamed those one-liners into chat used
      // to sit here — real-terminal testing found it was *why* the model kept
      // reaching for ralphflow_watch on totally unrelated turns: those lines
      // ("▸ [create] bash mkdir -p ...", "▸ [create] report_done") accumulate
      // in the transcript the model re-reads on every future invocation
      // (`triggerTurn: false` only skips waking it up immediately — the text
      // is still there next time it IS woken up, for any reason), and a model
      // that notices background activity in its own context tends to comment
      // on or act on it, unprompted. This directly violated the product's own
      // stated promise ("不需要你现在做任何事，也不需要主动去查看或汇报进度")
      // — DO/CHECK tool calls were never a "needs you" moment. Removing this
      // loses nothing for someone actually watching; it only stops narrating
      // to someone who isn't.
      runner = createRunner(engine, {
        onMessage: (_instId, text) => post(text),
        onGate: () => {},        // the gate's own message comes through onMessage
        onPaused: () => {},      // ditto
        onStalled: () => {},     // ditto
        onCompleted: () => {},   // ditto
      }, {
        skillPaths: () => loadSkillIndex(engine.getRalphFlowDir(), engine.getGlobalConfigHome()).paths,
      });

      // The engine needs to reach into this process to abort a DO session when
      // an instance is destroyed. (abortActiveCheck is wired at engine creation.)
      engine.setAbortActiveStep?.(runner.abortActiveStep);

      for (const tool of createTools({ engine, runner, getSessionId })) {
        api.registerTool(tool);
      }

      // Slash commands are thin: each hands its prompt template to the model,
      // which then calls the matching tool. Keeping the model in the loop is
      // what makes "/ralphflow-start" with no arguments ask what you want, and
      // what makes /ralphflow-create an actual conversation.
      for (const [name, template] of Object.entries(COMMAND_PROMPTS)) {
        api.registerCommand(name, {
          description: template.description,
          handler: async (args: string) => {
            api.sendUserMessage(template.render(args));
          },
        });
      }

      // Adopt whatever was left running: a crashed process leaves live instance
      // dirs behind, and the user should not have to know to type continue.
      for (const info of engine.listInstances()) {
        if (info.state.paused) continue;
        if (engine.foreignRunnerPid(info.id) !== null) continue; // someone else has it
        runner.ensureRunning(info.id);
      }
    },
  };

  return {
    extension,
    get runner() { return runner; },
    shutdown: () => runner?.pauseAllForShutdown(),
  };
}
