// The compile panel's two feed item shapes. The stores never cross: status
// events come from the host's compile-status feed, per-line compiler output
// lands in the log feed — merging them is a view concern.

/** One entry of the 编译 tab's event log (a compile-status transition). */
export interface CompileEvent {
  /** Wall-clock capture time (Date.now) of the payload's arrival. */
  at: number
  status: string
  message: string
  /** True when the payload came from a watcher rebuild (热更新 chip). */
  hotReload?: boolean
  /**
   * Optional shared monotonic arrival counter spanning compile events AND
   * compile logs — the panel's same-`at` tie-break: `at` is a
   * millisecond stamp, so an event and the log lines of the same compile
   * routinely collide on it.
   */
  seq?: number
}

/** One per-line compiler log entry. `at` is the capture timestamp. */
export interface CompileLogEntry {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
  /**
   * Optional shared monotonic arrival counter spanning compile EVENTS and
   * LOGS. `at` is a millisecond stamp, so a status event and the log lines
   * of the same compile routinely collide on the same `at` — the panel uses
   * `seq` as the same-`at` tie-break so the merged timeline keeps true
   * arrival order.
   */
  seq?: number
}
