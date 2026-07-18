/**
 * An in-memory Terminal for driving a REAL pi-tui TUI in tests, so
 * runInstanceInTui/attachRunView get exercised against the actual Container/
 * Input/focus machinery instead of a hand-rolled stub of it.
 */
import type { Terminal } from "../pi/tui.js";

export function createFakeTerminal(cols = 100, rows = 40): Terminal {
  return {
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    get columns() { return cols; },
    get rows() { return rows; },
    get kittyProtocolActive() { return false; },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}

/** Feed a string into a TUI one character at a time, the way real input arrives. */
export function typeInto(tui: { handleInput(data: string): void }, text: string): void {
  for (const ch of text) tui.handleInput(ch);
}
