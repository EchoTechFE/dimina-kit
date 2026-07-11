/**
 * Guards `start()`'s writer-lock arbitration in fs-core-recovery.ts: the
 * worker queues for the `navigator.locks` writer lease, serves readonly
 * after a 3s deadline if the lease has not landed yet, and upgrades once a
 * deferred grant arrives. A rejected lock request (the lease will never
 * come — e.g. the browser aborts the request) must not be treated the same
 * as "still queued": before the deadline it must fail startup outright;
 * after the deadline it must kill the worker (FATAL) instead of serving
 * readonly forever with no path back to writer.
 *
 * `navigator`/`BroadcastChannel` are OPFS/Web-Locks browser globals absent
 * from the Node vitest environment, so both are stubbed via `vi.stubGlobal`.
 * `core` is a structural fake — only the fields `start()` actually touches —
 * narrowed through `as unknown as FsCore` (see client.test.ts's
 * `ClientInternals` for the same pattern; no `as any`/`@ts-expect-error`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as recovery from './fs-core-recovery.js'
import type { FsCore } from './fs-core.worker.js'
import type { FsCoreMode } from './worker-lib/protocol.js'

type LockRequestFn = (name: string, opts: unknown, cb: (lock: unknown) => Promise<void>) => Promise<unknown>

interface FakeCore {
  projectId: string
  root: unknown
  bc: unknown
  mode: FsCoreMode
  releaseLock: (() => void) | null
  recover: () => Promise<void>
  becomeWriter: () => Promise<void>
  pushFullToQuery: () => void
  welcome: () => void
  event: (e: unknown) => void
  enqueue: (fn: () => unknown) => Promise<unknown>
  onBroadcast: (msg: { type?: string }) => Promise<void>
}

function makeCore(overrides: Partial<FakeCore> = {}): FakeCore {
  return {
    projectId: '',
    root: undefined,
    bc: undefined,
    mode: 'starting',
    releaseLock: null,
    recover: vi.fn(async () => {}),
    becomeWriter: vi.fn(async () => {}),
    pushFullToQuery: vi.fn(),
    welcome: vi.fn(),
    event: vi.fn(),
    enqueue: vi.fn((fn: () => unknown) => Promise.resolve(fn())),
    onBroadcast: vi.fn(async () => {}),
    ...overrides,
  }
}

/** Stand-in for the global `BroadcastChannel` ctor `start()` calls directly
 * (`new BroadcastChannel('dwc:' + projectId)`) — not reachable through the
 * fake `core` object since `start()` overwrites `core.bc` itself. */
class FakeBroadcastChannel {
  name: string
  onmessage: ((e: MessageEvent) => void) | null = null
  posted: unknown[] = []
  constructor(name: string) { this.name = name }
  postMessage(msg: unknown): void { this.posted.push(msg) }
  close(): void {}
}

function stubBrowserGlobals(request: LockRequestFn): void {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({}) }) },
    locks: { request },
  })
}

describe('fs-core-recovery start() — writer-lock arbitration', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('promotes to writer immediately when the lease is granted before the 3s deadline', async () => {
    vi.useFakeTimers()
    const request: LockRequestFn = vi.fn((_name, _opts, cb) => cb({}))
    stubBrowserGlobals(request)
    const core = makeCore()

    await recovery.start(core as unknown as FsCore, 'proj-a')

    expect(core.becomeWriter).toHaveBeenCalledTimes(1)
    expect(core.welcome).toHaveBeenCalledTimes(1)
    // recover()/pushFullToQuery() are only called directly on the readonly
    // (timeout) branch — their absence here is evidence the happy path, not
    // the deadline fallback, was taken.
    expect(core.recover).not.toHaveBeenCalled()
    expect(core.pushFullToQuery).not.toHaveBeenCalled()
  })

  it('a lock request that rejects before the 3s deadline must reject start(), not silently become the writer', async () => {
    vi.useFakeTimers()
    const request: LockRequestFn = vi.fn(() => Promise.reject(new Error('writer lock request aborted')))
    stubBrowserGlobals(request)
    const core = makeCore()

    await expect(recovery.start(core as unknown as FsCore, 'proj-b')).rejects.toThrow()

    expect(core.becomeWriter).not.toHaveBeenCalled()
    expect(core.mode).not.toBe('writer')
  })

  it('falls back to readonly at the 3s deadline, then upgrades once the deferred lock is granted', async () => {
    vi.useFakeTimers()
    let grantCb!: (lock: unknown) => Promise<void>
    const request: LockRequestFn = vi.fn((_name, _opts, cb) => {
      grantCb = cb
      return new Promise(() => {}) // only settles through cb's own held-lock promise, unused here
    })
    stubBrowserGlobals(request)
    const core = makeCore()

    const startPromise = recovery.start(core as unknown as FsCore, 'proj-c')
    await vi.advanceTimersByTimeAsync(3000)
    await startPromise

    expect(core.recover).toHaveBeenCalledTimes(1)
    expect(core.mode).toBe('readonly')
    expect(core.welcome).toHaveBeenCalledTimes(1)
    expect(core.becomeWriter).not.toHaveBeenCalled()

    grantCb({})
    await vi.advanceTimersByTimeAsync(0)

    expect(core.enqueue).toHaveBeenCalledTimes(1)
    expect(core.becomeWriter).toHaveBeenCalledTimes(1)
  })

  it('a lock request that rejects only after the 3s deadline must kill the worker (FATAL), not stay readonly forever', async () => {
    vi.useFakeTimers()
    let rejectLock!: (e: unknown) => void
    const request: LockRequestFn = vi.fn(() => new Promise((_resolve, reject) => { rejectLock = reject }))
    stubBrowserGlobals(request)
    const core = makeCore()

    const startPromise = recovery.start(core as unknown as FsCore, 'proj-d')
    await vi.advanceTimersByTimeAsync(3000)
    await startPromise

    expect(core.mode).toBe('readonly')
    expect(core.becomeWriter).not.toHaveBeenCalled()

    rejectLock(new Error('writer lock request aborted'))
    await vi.advanceTimersByTimeAsync(0)

    expect(core.becomeWriter).not.toHaveBeenCalled()
    expect(core.mode).toBe('dead')
    expect(core.event).toHaveBeenCalledWith(expect.objectContaining({ type: 'FATAL' }))
  })
})
