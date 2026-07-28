// The host-transport contract behind the 编译 panel: the panel's data wiring
// (seed, live event/log appends with FIFO caps, visibility gating, clearing)
// is written ONCE against this interface (see ConnectedCompilePanel); each
// host only implements how the operations travel — Electron IPC pushes, an
// in-page compile-service callback, or anything else.
import type { CompileEvent, CompileLogEntry } from './compile-types.js'

/** The seed payload: both stores, chronological (oldest first). Cross-stream
 * order between an event and a log sharing the same millisecond `at` is only
 * preserved when the host stamps `seq` itself — an unstamped snapshot gets
 * `seq` assigned per store (events first), so such ties sort event-first. */
export interface CompileFeedSnapshot {
  events: CompileEvent[]
  logs: CompileLogEntry[]
}

/** One live push: a status event, a log line, or a host-side history reset. */
export type CompileFeedEvent =
  | { kind: 'event'; event: CompileEvent }
  | { kind: 'log'; log: CompileLogEntry }
  | { kind: 'reset' }

export interface CompilePanelSource {
  /** Fetch the current feed history (seed on panel activation). */
  getSnapshot(): Promise<CompileFeedSnapshot>
  /** Live feed pushes; returns an unsubscribe function. */
  subscribe(onEvent: (evt: CompileFeedEvent) => void): () => void
  /** Visibility gate: hosts whose feed costs something only keep it armed
   * while some panel is visible. */
  setActive(on: boolean): void
  /** Clear the host-side history. Optional: the panel's 清空 empties its
   * local timeline regardless; hosts that keep no history of their own can
   * omit this. */
  clear?(): void | Promise<void>
}
