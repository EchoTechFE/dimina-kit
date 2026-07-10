// The host-transport contract behind the WXML panel: the panel's data wiring
// (seed, live push, visibility gating, element inspection) is written ONCE
// against this interface (see ConnectedWxmlPanel); each host only implements
// how the five operations travel — Electron IPC channels, iframe postMessage,
// or anything else.
import type { ElementInspection, WxmlNode } from './types.js'

export interface WxmlPanelSource {
  /** Fetch the current tree snapshot (seed / manual refresh). */
  getSnapshot(): Promise<WxmlNode | null>
  /** Live tree pushes; returns an unsubscribe function. */
  subscribe(onTree: (tree: WxmlNode | null) => void): () => void
  /** Visibility gate: the producer only observes the page DOM (and pays the
   * Vue-tree walk) while some panel is visible. */
  setActive(on: boolean): void
  /** Measure the element with `sid`; the producer draws its own highlight. */
  inspect(sid: string): Promise<ElementInspection | null>
  /** Drop the current measurement highlight. */
  clearInspection(): void | Promise<void>
}
