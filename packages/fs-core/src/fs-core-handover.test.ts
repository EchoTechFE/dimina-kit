/**
 * Guards `requestHandover(core)` — the readonly-side counterpart to the
 * writer-side handover in `onBroadcast` (fs-core-recovery.ts): a readonly
 * client actively asking the current writer to hand off the lease, instead
 * of only ever passively upgrading once a queued `navigator.locks` request
 * happens to land. Also guards the client-facing `ProjectFsClient.requestHandover()`
 * wrapper that posts the RPC.
 *
 * `core` is a structural fake — only the fields `requestHandover`/`onBroadcast`
 * touch — narrowed through `as unknown as FsCore`, matching the pattern in
 * client.test.ts/fs-core-recovery-lock.test.ts (no `as any`/`@ts-expect-error`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onBroadcast, requestHandover } from './fs-core-recovery.js'
import type { FsCore } from './fs-core.worker.js'
import { isFsCoreErrorCode, type CoreMessage, type FsCoreMode } from './worker-lib/protocol.js'
import { ProjectFsClient } from './client.js'

type LockRequestFn = (name: string, opts: unknown, cb: (lock: unknown) => Promise<void>) => Promise<unknown>

interface FakeCore {
  mode: FsCoreMode
  bc: { postMessage: (msg: unknown) => void }
  writerLockQueued: boolean
  handoverRequested: boolean
  becomeWriter: () => Promise<void>
  enqueue: (fn: () => unknown) => Promise<unknown>
}

function makeCore(overrides: Partial<FakeCore> = {}): FakeCore {
  return {
    mode: 'readonly',
    bc: { postMessage: vi.fn() },
    writerLockQueued: false,
    handoverRequested: false,
    becomeWriter: vi.fn(async () => {}),
    enqueue: vi.fn((fn: () => unknown) => Promise.resolve(fn())),
    ...overrides,
  }
}

describe('fs-core-recovery requestHandover() — readonly-initiated handover request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode writer returns {mode:\'writer\'} immediately — no broadcast, no lock request', async () => {
    const request: LockRequestFn = vi.fn()
    vi.stubGlobal('navigator', { locks: { request } })
    const core = makeCore({ mode: 'writer' })

    const result = await requestHandover(core as unknown as FsCore)

    expect(result).toEqual({ mode: 'writer' })
    expect(core.bc.postMessage).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('mode draining rejects with the draining error code', async () => {
    const core = makeCore({ mode: 'draining' })
    let caught: unknown
    try {
      await requestHandover(core as unknown as FsCore)
    } catch (e) {
      caught = e
    }
    expect(isFsCoreErrorCode(caught, 'draining')).toBe(true)
  })

  it('mode dead returns {mode:\'dead\'} without broadcasting or requesting a lock', async () => {
    // A FATAL'd worker cannot upgrade even if the lease later lands (the
    // deferred writer upgrade bails on dead), so broadcasting
    // handover-request from it would only drain a healthy writer for nothing.
    const request: LockRequestFn = vi.fn()
    vi.stubGlobal('navigator', { locks: { request } })
    const core = makeCore({ mode: 'dead' })

    const result = await requestHandover(core as unknown as FsCore)

    expect(result).toEqual({ mode: 'dead' })
    expect(core.bc.postMessage).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(core.handoverRequested).toBe(false)
  })

  it('mode starting returns {mode:\'starting\'} without broadcasting or requesting a lock', async () => {
    // start()'s own lock arbitration is still in flight — acting here would
    // race it with a second queued lock request and a premature broadcast.
    const request: LockRequestFn = vi.fn()
    vi.stubGlobal('navigator', { locks: { request } })
    const core = makeCore({ mode: 'starting' })

    const result = await requestHandover(core as unknown as FsCore)

    expect(result).toEqual({ mode: 'starting' })
    expect(core.bc.postMessage).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(core.handoverRequested).toBe(false)
  })

  it('mode readonly with a lock already queued rebroadcasts without requesting a second lock', async () => {
    const request: LockRequestFn = vi.fn()
    vi.stubGlobal('navigator', { locks: { request } })
    const core = makeCore({ mode: 'readonly', writerLockQueued: true })

    const result = await requestHandover(core as unknown as FsCore)

    expect(result).toEqual({ requested: true })
    expect(core.bc.postMessage).toHaveBeenCalledTimes(1)
    expect(core.bc.postMessage).toHaveBeenCalledWith({ type: 'handover-request' })
    expect(request).not.toHaveBeenCalled()
  })

  it('mode readonly with no lock queued issues a fresh writer-lock request and upgrades once granted', async () => {
    let grantCb!: (lock: unknown) => Promise<void>
    const request: LockRequestFn = vi.fn((_name, _opts, cb) => {
      grantCb = cb
      return new Promise(() => {})
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const core = makeCore({ mode: 'readonly', writerLockQueued: false })

    const result = await requestHandover(core as unknown as FsCore)

    expect(result).toEqual({ requested: true })
    expect(request).toHaveBeenCalledTimes(1)
    expect(core.bc.postMessage).toHaveBeenCalledWith({ type: 'handover-request' })
    expect(core.becomeWriter).not.toHaveBeenCalled()

    grantCb({})
    await Promise.resolve()
    await Promise.resolve()

    expect(core.enqueue).toHaveBeenCalled()
    expect(core.becomeWriter).toHaveBeenCalledTimes(1)
  })

  it('a repeated call within the same pending cycle merges: no extra lock request or broadcast', async () => {
    const request: LockRequestFn = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('navigator', { locks: { request } })
    const core = makeCore({ mode: 'readonly', writerLockQueued: false })

    const first = await requestHandover(core as unknown as FsCore)
    const second = await requestHandover(core as unknown as FsCore)

    expect(first).toEqual({ requested: true })
    expect(second).toEqual({ requested: true })
    expect(request).toHaveBeenCalledTimes(1)
    expect(core.bc.postMessage).toHaveBeenCalledTimes(1)
  })

  it('a handover-done broadcast clears the merge flag so a later requestHandover broadcasts again', async () => {
    const request: LockRequestFn = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('navigator', { locks: { request } })
    const core = makeCore({ mode: 'readonly', writerLockQueued: false })

    await requestHandover(core as unknown as FsCore) // 1st: broadcasts, marks the pending cycle
    await onBroadcast(core as unknown as FsCore, { type: 'handover-done' })
    await requestHandover(core as unknown as FsCore) // merge flag reset — broadcasts again

    expect(core.bc.postMessage).toHaveBeenCalledTimes(2)
  })
})

type ClientInternals = Omit<ProjectFsClient, 'core'> & {
  pending: Map<number, unknown>
  seq: number
  core: { postMessage: (msg: unknown) => void }
  _onCoreMessage(msg: CoreMessage, resolveWelcome?: (w: CoreMessage) => void, rejectWelcome?: (e: Error) => void): void
  requestHandover(): Promise<unknown>
}

function makeBareRpcClient(): { client: ClientInternals; posted: Array<{ id: number; op: string }> } {
  const posted: Array<{ id: number; op: string }> = []
  const c = new ProjectFsClient() as unknown as ClientInternals
  c.pending = new Map()
  c.seq = 0
  c.core = { postMessage: (msg) => posted.push(msg as { id: number; op: string }) }
  return { client: c, posted }
}

describe('ProjectFsClient.requestHandover', () => {
  it('posts a requestHandover op to the core worker and resolves via the RPC reply', async () => {
    const { client, posted } = makeBareRpcClient()

    const p = client.requestHandover()

    expect(posted).toHaveLength(1)
    expect(posted[0]!.op).toBe('requestHandover')

    client._onCoreMessage({ id: posted[0]!.id, ok: true, result: { requested: true } } as CoreMessage)

    await expect(p).resolves.toEqual({ requested: true })
  })
})
