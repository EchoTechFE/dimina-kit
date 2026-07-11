/**
 * Guards the opId idempotent-replay cache's payload completeness: when a
 * timed-out client retries with the same opId, handleRpc (fs-core.worker.ts)
 * answers from `core.opIds` instead of re-executing — so the cached entry
 * must carry the FULL result the live path responded with. A cache that only
 * stores `{gen}` makes the replay lose checkpoint's cpId, turnBegin's
 * turnId/cpId/expiresAt, and restore's restored count, breaking the client's
 * typed result contract (client.ts declares those fields as always present).
 *
 * Recovery-rebuilt entries legitimately hold only `{gen}` (WAL records do not
 * persist in-memory extras) — that cross-session degradation is documented at
 * the implementation, not tested here; these tests pin the LIVE path only.
 *
 * `core` fakes are structural (only the fields flushWindow/opRestore touch),
 * narrowed via `as unknown as FsCore`; `rememberOpId` is the REAL
 * implementation bound to the fake so assertions read the actual cache Map.
 */
import { describe, expect, it, vi } from 'vitest'
import * as writeOps from './fs-core-write-ops.js'
import type { FsCore } from './fs-core.worker.js'
import type { Respond, WindowOp } from './worker-lib/engine-shared.js'

interface FakeFlushCore {
  flushTimer: ReturnType<typeof setTimeout> | null
  windowOps: WindowOp[]
  walHandle: { flush: () => void }
  walGen: number
  appendedGen: number
  memGen: number
  ackGen: number
  staged: Map<string, unknown>
  mirror: Map<string, unknown>
  opIds: Map<string, { gen: number }>
  pushDiff: (diff: Record<string, unknown>, gen: number) => void
  rememberOpId: (opId: string, v: { gen: number }) => void
  event: (e: unknown) => void
  bc: { postMessage: (msg: unknown) => void }
}

function makeFlushCore(windowOps: WindowOp[]): FakeFlushCore {
  const core: FakeFlushCore = {
    flushTimer: null,
    windowOps,
    walHandle: { flush: vi.fn() },
    walGen: 0,
    appendedGen: Math.max(0, ...windowOps.map((w) => w.gen)),
    memGen: 0,
    ackGen: 0,
    staged: new Map(),
    mirror: new Map(),
    opIds: new Map(),
    pushDiff: vi.fn(),
    rememberOpId: (opId, v) => writeOps.rememberOpId(core as unknown as FsCore, opId, v),
    event: vi.fn(),
    bc: { postMessage: vi.fn() },
  }
  return core
}

describe('flushWindow — opId replay cache stores the full respond result', () => {
  it('caches a checkpoint windowOp as {gen, rev, cpId}, matching what the live respond delivered', () => {
    const respond = vi.fn()
    const core = makeFlushCore([{ respond, gen: 3, actor: 'human', opId: 'op-c1', extra: { cpId: 'c1' } }])

    writeOps.flushWindow(core as unknown as FsCore)

    expect(respond).toHaveBeenCalledWith({ ok: true, result: { gen: 3, rev: 3, cpId: 'c1' } })
    // A retry replay answers from this entry verbatim — a {gen}-only cache
    // would hand the client a checkpoint result with no cpId.
    expect(core.opIds.get('op-c1')).toEqual({ gen: 3, rev: 3, cpId: 'c1' })
  })

  it('caches a turnBegin windowOp as {gen, rev, turnId, cpId, expiresAt}', () => {
    const respond = vi.fn()
    const extra = { turnId: 't-1', cpId: 'cp-9', expiresAt: 4200 }
    const core = makeFlushCore([{ respond, gen: 6, actor: 'agent', opId: 'op-t1', extra }])

    writeOps.flushWindow(core as unknown as FsCore)

    expect(respond).toHaveBeenCalledWith({ ok: true, result: { gen: 6, rev: 6, ...extra } })
    expect(core.opIds.get('op-t1')).toEqual({ gen: 6, rev: 6, ...extra })
  })

  it('caches a plain write windowOp (no extra) as {gen, rev}', () => {
    const respond = vi.fn()
    const core = makeFlushCore([{ respond, gen: 4, path: 'a.txt', actor: 'human', opId: 'op-w1' }])

    writeOps.flushWindow(core as unknown as FsCore)

    expect(respond).toHaveBeenCalledWith({ ok: true, result: { gen: 4, rev: 4 } })
    expect(core.opIds.get('op-w1')).toEqual({ gen: 4, rev: 4 })
  })
})

interface FakeRestoreCore {
  mode: string
  flushWindow: () => void
  rotateIfNeeded: () => Promise<void>
  checkpoints: Map<string, { h: string; gen: number }>
  readBlob: (h: string) => Promise<string>
  appendSync: (opcode: number, meta: Record<string, unknown>, checks?: () => void) => number
  checkTurn: (actor: string | undefined, turnId: string | undefined, agentToken: string | undefined) => void
  checkRestoreConflict: (baseGen: number) => void
  walHandle: { flush: () => void }
  walGen: number
  memGen: number
  ackGen: number
  mirror: Map<string, unknown>
  opIds: Map<string, { gen: number }>
  rememberOpId: (opId: string, v: { gen: number }) => void
  pushFullToQuery: () => void
  event: (e: unknown) => void
  bc: { postMessage: (msg: unknown) => void }
}

/** Two files in the checkpoint manifest — opRestore's live respond carries
 * restored: 2, and the replay cache must preserve it. */
function makeRestoreCore(): FakeRestoreCore {
  const manifest: Record<string, string> = { 'a.txt': 'h-a', 'b.txt': 'h-b' }
  const core: FakeRestoreCore = {
    mode: 'writer',
    flushWindow: vi.fn(),
    rotateIfNeeded: vi.fn(async () => {}),
    checkpoints: new Map([['cp-1', { h: 'h-manifest', gen: 5 }]]),
    readBlob: vi.fn(async (h: string) => (h === 'h-manifest' ? JSON.stringify(manifest) : 'content-of-' + h)),
    appendSync: vi.fn((_opcode: number, _meta: Record<string, unknown>, checks?: () => void) => {
      checks?.()
      return 7
    }),
    checkTurn: vi.fn(),
    checkRestoreConflict: vi.fn(),
    walHandle: { flush: vi.fn() },
    walGen: 0,
    memGen: 0,
    ackGen: 0,
    mirror: new Map(),
    opIds: new Map(),
    rememberOpId: (opId, v) => writeOps.rememberOpId(core as unknown as FsCore, opId, v),
    pushFullToQuery: vi.fn(),
    event: vi.fn(),
    bc: { postMessage: vi.fn() },
  }
  return core
}

describe('opRestore — opId replay cache stores the full respond result', () => {
  it('caches a restore as {gen, restored}, matching what the live respond delivered', async () => {
    const core = makeRestoreCore()
    const respond: Respond = vi.fn()

    await writeOps.opRestore(core as unknown as FsCore, { cpId: 'cp-1', actor: 'human', opId: 'op-r1' }, respond)

    expect(respond).toHaveBeenCalledWith({ ok: true, result: { gen: 7, restored: 2 } })
    // A retry replay answers from this entry verbatim — a {gen}-only cache
    // would hand the client a restore result with no restored count.
    expect(core.opIds.get('op-r1')).toEqual({ gen: 7, restored: 2 })
  })
})
