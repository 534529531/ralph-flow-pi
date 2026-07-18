/**
 * The single point of contact with pi-tui and pi's theme module.
 *
 * Same anti-corruption discipline as adapter.ts: pi-tui is on the same fast 0.x
 * cadence as the SDK, so every `@earendil-works/pi-tui` and theme import lives
 * here and the run view talks only to these re-exports. A pi-tui API change is a
 * one-file fix.
 */

export {
  TUI,
  Container,
  Text,
  Markdown,
  SelectList,
  Input,
  ProcessTerminal,
  matchesKey,
  parseKey,
  Key,
  type Component,
  type SelectItem,
  type SelectListTheme,
  type Terminal,
  type EditorTheme,
} from "@earendil-works/pi-tui";

export {
  visibleWidth,
  wrapTextWithAnsi,
  truncateToWidth,
} from "@earendil-works/pi-tui";

export {
  initTheme,
  getSelectListTheme,
  getMarkdownTheme,
  CustomEditor,
  Theme,
  type KeybindingsManager,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
