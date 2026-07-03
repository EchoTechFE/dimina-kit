/**
 * Pure batch-packing for the native dispatch queue: greedily pack queued CDP
 * messages up to `maxBatchChars` so one `executeJavaScript` call stays sized,
 * pulling any oversized message (over `maxSingleChars`) into `chunked` for the
 * separate chunked transport instead.
 *
 * An oversized message reached while `batch` is still empty is queued into
 * `chunked` immediately and packing continues past it, so several oversized
 * messages in a row are all pulled out in one pass. One reached once `batch`
 * already has items stops packing there, leaving it (and everything after) in
 * `remaining` for the next flush — this preserves delivery order across passes.
 */
export interface PackedDispatchBatch {
  /** Messages to send in one `executeJavaScript` batch dispatch. */
  batch: string[]
  /** Oversized messages to dispatch individually via the chunked transport. */
  chunked: string[]
  /** Whatever the queue had left after this pass. */
  remaining: string[]
}

export function packDispatchBatch(
  queue: readonly string[],
  maxSingleChars: number,
  maxBatchChars: number,
): PackedDispatchBatch {
  const batch: string[] = []
  const chunked: string[] = []
  let batchChars = 0
  let i = 0
  for (; i < queue.length; i++) {
    const msg = queue[i]!
    if (msg.length > maxSingleChars) {
      if (batch.length > 0) break
      chunked.push(msg)
      continue
    }
    if (batch.length > 0 && batchChars + msg.length > maxBatchChars) break
    batch.push(msg)
    batchChars += msg.length
  }
  return { batch, chunked, remaining: queue.slice(i) }
}
