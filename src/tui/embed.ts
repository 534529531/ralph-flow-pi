/**
 * The chat session's "take over the terminal to run a workflow" seam.
 *
 * `ralphflow_start`/`ralphflow_continue`/`ralphflow_watch` (commands/tools.ts)
 * call `attachRunView` once an instance is actively running. It borrows the
 * SAME `TUI` the chat session already owns (via Pi's `ctx.ui.custom()`) rather
 * than spawning a second one — save the chat's current root components,
 * clear, mount the run view, run it to completion/cancellation/detach,
 * restore the saved components, hand back.
 *
 * Verified against a real terminal + real model (see fancy-purring-sparkle.md
 * step 3): the chat's header/transcript/editor survive a takeover-and-restore
 * cycle intact, and the model resumes exactly where it left off. The one
 * subtlety that mattered in that spike: the factory passed to `ui.custom`
 * must not resolve until AFTER `done()` has been called. `showExtensionCustom`
 * does `Promise.resolve(factory(...)).then(c => { if (!closed) { editor
 * Container.clear(); editorContainer.addChild(c); ... } })` the moment the
 * factory's returned promise settles — if that happened while we're still
 * mid-takeover, it would clobber the chat's real editor with `undefined`.
 * Keeping the factory itself pending until we call `done()` (which flips
 * `closed` to true) makes that branch a no-op.
 */

import type { Engine } from "../engine/core.js";
import type { Runner } from "../engine/runner.js";
import { runInstanceInTui, type RunInstanceOutcome } from "./run-app.js";
import type { TUI } from "../pi/tui.js";

/**
 * The slice of Pi's extension context this file touches. `custom`'s result is
 * `T | undefined` to match Pi's real signature (`done` takes an optional
 * result) — we always call `done(result)` with a real value below, so
 * `attachRunView` narrows it back to a guaranteed `RunInstanceOutcome` for
 * its own callers.
 */
export interface UiCustomHost {
  ui: { custom<T>(factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result?: T) => void) => unknown): Promise<T | undefined> };
  /** ExtensionContext.abort — see tools.ts's attachResult for why this, not just `terminate`, is called on detach. */
  abort?(): void;
}

export async function attachRunView(
  ctx: UiCustomHost,
  engine: Engine,
  runner: Runner,
  sessionId: string,
  instId: string,
): Promise<RunInstanceOutcome> {
  const result = await ctx.ui.custom<RunInstanceOutcome>(async (tui, _theme, _keybindings, done) => {
    const saved = [...tui.children];
    tui.clear();
    const outcome = await runInstanceInTui({ engine, tui, sessionId, instId, runner });
    tui.clear();
    for (const c of saved) tui.addChild(c);
    tui.requestRender(true);
    done(outcome);
    return undefined; // ignored: `done()` already closed the custom UI
  });
  return result ?? { outcome: "detached" };
}
