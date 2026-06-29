/**
 * Lifecycle serialization primitive for the workspace's openProject/closeProject.
 *
 * Two parts working together (see workspace-service for the full rationale):
 *  - A FIFO async lock so the teardown/commit critical sections of open and
 *    close never interleave. The unbounded compile runs between an open's two
 *    sections WITHOUT holding the lock, so a queued close is never blocked by a
 *    slow/hung compile (close is bounded by disposeSession's own timeout).
 *  - A latest-wins request token. `nextSeq()` is claimed at the START of every
 *    op (before any await) so it encodes REQUEST order, not hook/compile
 *    completion order. `takeOwnership` promotes a seq (highest wins); a section
 *    that finds `!isOwner(mySeq)` was superseded while it released the lock and
 *    must abort instead of clobbering the newer request's runtime.
 */
export interface OpLock {
  /** Claim a monotonic request seq. Call once at op entry, before any await. */
  nextSeq(): number
  /** Promote a seq to the runtime owner. Only the highest seq ever wins. */
  takeOwnership(seq: number): void
  /** Whether `seq` is still the current owner (false ⇒ superseded). */
  isOwner(seq: number): boolean
  /** Acquire the FIFO lock; await the result, then call it to release. */
  acquire(): Promise<() => void>
}

export function createOpLock(): OpLock {
  let chain: Promise<void> = Promise.resolve()
  let requestSeq = 0
  let ownerSeq = 0
  return {
    nextSeq: () => ++requestSeq,
    takeOwnership: (seq) => {
      if (seq > ownerSeq) ownerSeq = seq
    },
    isOwner: (seq) => seq === ownerSeq,
    acquire: () => {
      let release!: () => void
      const next = new Promise<void>((resolve) => {
        release = resolve
      })
      const prior = chain
      chain = prior.then(() => next)
      return prior.then(() => release)
    },
  }
}
