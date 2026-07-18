/**
 * Booting pi's InteractiveMode, kept behind the anti-corruption layer with the
 * rest of the SDK contact (see adapter.ts).
 *
 * The assembly mirrors what pi's own `main.ts` does, minus every CLI concern we
 * don't have (flag parsing, --api-key, model scopes, print/rpc modes):
 *
 *   services  ← createAgentSessionServices, carrying our inline extension
 *   session   ← createAgentSessionFromServices
 *   runtime   ← createAgentSessionRuntime
 *   UI        ← new InteractiveMode(runtime).run()
 *
 * The extension is passed as an `extensionFactories` entry, which is how pi
 * loads in-process extensions — the same door its own bundled ones come through.
 */

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface BootInteractiveOptions {
  cwd: string;
  /** An inline extension: `{ name, factory(api) }`. */
  extension: unknown;
  /** If set, sent as the first message on startup (used to seed the create flow). */
  initialMessage?: string;
  /** Receives the main session's id once it exists. */
  onSessionId(id: string): void;
  /** Run on SIGINT / normal exit, before the process goes away. */
  onShutdown(): void;
}

export async function bootInteractive(options: BootInteractiveOptions): Promise<void> {
  const { cwd, extension, initialMessage, onSessionId, onShutdown } = options;
  const agentDir = getAgentDir();
  const sessionManager = SessionManager.create(cwd);

  const runtime = await createAgentSessionRuntime(
    async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager: sm, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        resourceLoaderOptions: {
          extensionFactories: [extension as any],
        },
      });
      const created = await createAgentSessionFromServices({ services, sessionManager: sm, sessionStartEvent });
      return { ...created, services, diagnostics: [...services.diagnostics] };
    },
    { cwd, agentDir, sessionManager },
  );

  onSessionId(sessionManager.getSessionId());

  // Interrupted instances must be parked before we die, or their next run would
  // see a live-looking state with a dead pid and have to guess. Registered
  // before the UI starts so a crash during startup is still covered.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { onShutdown(); } catch {}
  };
  process.on("exit", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const interactive = new InteractiveMode(runtime, initialMessage ? { initialMessage } : undefined);
  try {
    await interactive.init();
    await interactive.run();
  } finally {
    shutdown();
  }
}
