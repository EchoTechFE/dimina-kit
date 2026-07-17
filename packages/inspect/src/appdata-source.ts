// The host-transport contract behind the AppData panel: the panel's data
// wiring (seed, live full-snapshot pushes, visibility gating) is written ONCE
// against this interface (see ConnectedAppDataPanel); each host only
// implements how the operations travel — Electron IPC channels, a same-origin
// Worker-message tap feeding an AppDataAccumulator, or anything else.
import type { AppDataSnapshot } from './appdata-accumulator.js'

export interface AppDataPanelSource {
  /** Fetch the current cumulative snapshot (seed on panel activation). */
  getSnapshot(): Promise<AppDataSnapshot>
  /** Live pushes — each push carries the FULL cumulative snapshot, not a
   * delta (merging setData patches is the producer-side accumulator's job);
   * returns an unsubscribe function. */
  subscribe(onSnapshot: (snapshot: AppDataSnapshot) => void): () => void
  /** Visibility gate: hosts whose feed costs something (listeners, walks)
   * only keep it armed while some panel is visible. */
  setActive(on: boolean): void
  /** Write an edit back into the running page (`page.setData(patch)`); patch
   * keys use setData path syntax (`a.b`, `list[0].id`). Resolves true when the
   * write was dispatched to a live runtime. Absent → the host has no
   * write-back channel and the panel renders read-only. */
  setData?: (bridgeId: string, patch: Record<string, unknown>) => Promise<boolean>
}
