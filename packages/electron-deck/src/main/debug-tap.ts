/**
 * debugTap (foundation.md §7) — a flag-gated ring buffer for observing an
 * IPC / cross-wc bridge message stream.
 *
 * Hung on a dispatch chokepoint (e.g. bridge-router's SERVICE_INVOKE /
 * RENDER_INVOKE / PUBLISH / API_RESPONSE handlers), it records per-message
 * metadata — connection id / channel / direction / appSession / duration /
 * error — into a bounded ring so a hidden panel (or a test) can inspect the
 * last N messages when debugging the cross-wc state machine.
 *
 * Design constraints:
 *  - Default OFF: `record()` is a near-free no-op when disabled, so the hot
 *    path costs nothing in production unless the flag is set.
 *  - Caller-supplied `ts`: the electron-deck package never calls `Date.now()`
 *    (determinism / resumability), so each entry carries a timestamp the
 *    caller stamps.
 *  - Bounded: a finite ring (default 1000) evicts oldest-first; it never grows
 *    without bound.
 */

export interface DebugTapEntry {
  /** Caller-stamped timestamp (ms). The primitive never reads the clock. */
  ts: number
  /** The channel / message kind (e.g. 'SERVICE_INVOKE', 'API_RESPONSE'). */
  channel: string
  /** Ingress (main received) vs egress (main sent). */
  direction: 'in' | 'out'
  /** webContents.id of the connection this message is attributed to. */
  connectionId?: number
  /** bridge-router app session this message routes within, if known. */
  appSessionId?: string
  /** For request/response pairs: how long the handler took (ms). */
  durationMs?: number
  /** Error message if the message produced a failure. */
  error?: string
  /** Short human-readable summary of the payload (no large blobs). */
  summary?: string
}

export interface DebugTap {
  /** Whether recording is on. When false, `record` is a no-op. */
  readonly enabled: boolean
  /** Append one entry to the ring (no-op when disabled). */
  record(entry: DebugTapEntry): void
  /** Snapshot of buffered entries, oldest → newest. Safe to retain/mutate. */
  entries(): readonly DebugTapEntry[]
  /** Empty the ring. */
  clear(): void
}

export interface DebugTapOptions {
  /** Default false — the tap is OFF unless explicitly enabled. */
  enabled?: boolean
  /** Max retained entries; oldest evicted past this. Default 1000. */
  capacity?: number
}

const DEFAULT_CAPACITY = 1000

export function createDebugTap(options: DebugTapOptions = {}): DebugTap {
  const enabled = options.enabled ?? false
  const capacity =
    options.capacity && options.capacity > 0 ? Math.floor(options.capacity) : DEFAULT_CAPACITY

  // Simple bounded buffer: push to the tail, shift the head when over capacity.
  // For the modest capacities debugTap targets this is plenty; the hot path is
  // the disabled no-op, not eviction throughput.
  let buffer: DebugTapEntry[] = []

  return {
    get enabled() {
      return enabled
    },
    record(entry: DebugTapEntry): void {
      if (!enabled) return
      buffer.push(entry)
      if (buffer.length > capacity) {
        buffer.splice(0, buffer.length - capacity)
      }
    },
    entries(): readonly DebugTapEntry[] {
      // Return a copy so a retained snapshot is stable and callers can't mutate
      // the live ring.
      return buffer.slice()
    },
    clear(): void {
      buffer = []
    },
  }
}
