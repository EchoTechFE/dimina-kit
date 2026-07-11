/**
 * Contract tests for `createSyncEngine`'s `onDegraded` reporting: every
 * silent-fallback path (dead watcher, a transient truth-source read failure,
 * a ledger write failure while reconciling an inbound change) must surface
 * through the host-supplied `onDegraded` callback instead of only a
 * `console.warn`, and a host callback that itself throws must never wedge
 * the engine's own processing.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSyncEngine } from './sync-engine.js'
import type { SyncClientLike, SyncDegradation } from './sync-engine.js'
import type { TruthPort } from './truth-port.js'

function makeClient(overrides: Partial<SyncClientLike> = {}): SyncClientLike {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'not-found' })),
    ls: vi.fn().mockResolvedValue({ paths: [] }),
    ...overrides,
  }
}

function makePort(overrides: Partial<TruthPort> = {}): TruthPort {
  return {
    capabilities: { watch: 'push' },
    read: vi.fn().mockResolvedValue(new Uint8Array()),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    walk: vi.fn().mockResolvedValue(undefined),
    changes: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  }
}

/** Fake `port.changes`: captures the `onBatch`/`onDead` callbacks `start()`
 * registers and exposes them as `emitBatch`/`emitDead`, so a test can drive
 * the engine without a real event stream. */
function makeWatch(): {
  changes: TruthPort['changes']
  stop: ReturnType<typeof vi.fn>
  emitBatch: (paths: string[]) => void
  emitDead: () => void
} {
  let batchHandler: (paths: string[]) => void = () => {}
  let deadHandler: () => void = () => {}
  const stop = vi.fn()
  const changes: TruthPort['changes'] = (onBatch, onDead) => {
    batchHandler = onBatch
    deadHandler = onDead
    return stop
  }
  return {
    changes,
    stop,
    emitBatch: (paths) => batchHandler(paths),
    emitDead: () => deadHandler(),
  }
}

/** Flush the microtask queue enough times for a batch's chained port/ledger
 * reads+writes to settle before assertions run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createSyncEngine — onDegraded: dead watcher', () => {
  it('reports {kind: "watcher-dead"} exactly once and still disposes the subscription', async () => {
    const watch = makeWatch()
    const onDegraded = vi.fn<(d: SyncDegradation) => void>()
    const port = makePort({ changes: watch.changes })
    const client = makeClient()
    const engine = createSyncEngine(client, port, { onDegraded })

    await engine.populateLedger()
    engine.start()
    watch.emitDead()

    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith({ kind: 'watcher-dead' })
    // Dispose is the pre-existing contract this test must not regress.
    expect(watch.stop).toHaveBeenCalledTimes(1)
  })
})

describe('createSyncEngine — onDegraded: reentrant stop() from the host callback', () => {
  it('a host calling engine.stop() synchronously from onDegraded never double-disposes the watch subscription', async () => {
    // The TruthPort `changes` contract does not require the returned dispose
    // to be idempotent — a custom port may legitimately throw on a second
    // call. This fake enforces that: the engine must guarantee at most ONE
    // dispose call per subscription, even when the host reacts to
    // {kind:'watcher-dead'} by synchronously tearing the engine down.
    let disposeCalls = 0
    let deadHandler: () => void = () => {}
    const changes: TruthPort['changes'] = (_onBatch, onDead) => {
      deadHandler = onDead
      return () => {
        disposeCalls += 1
        if (disposeCalls > 1) throw new Error('dispose is not idempotent — called twice')
      }
    }
    const port = makePort({ changes })
    const client = makeClient()
    const engineRef: { current?: ReturnType<typeof createSyncEngine> } = {}
    const onDegraded = vi.fn<(d: SyncDegradation) => void>(() => {
      engineRef.current?.stop()
    })
    const engine = createSyncEngine(client, port, { onDegraded })
    engineRef.current = engine

    await engine.populateLedger()
    engine.start()
    expect(() => deadHandler()).not.toThrow()

    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith({ kind: 'watcher-dead' })
    expect(disposeCalls).toBe(1)
  })
})

describe('createSyncEngine — onDegraded: onDead fired synchronously during subscription', () => {
  it('a port firing onDead synchronously during subscription still tears down exactly once, without throwing', async () => {
    // The TruthPort `changes` contract does not forbid invoking the callbacks
    // DURING the subscription call itself — a port may discover its watcher
    // is already dead and fire onDead before returning the dispose function.
    // The engine must survive that ordering: start() must not throw (the
    // dispose reference must not be dereferenced before the subscription call
    // returns it), the host gets a single {kind:'watcher-dead'} degradation,
    // and the dispose is called exactly once after it exists — never twice,
    // neither here nor via a later stop().
    let disposeCalls = 0
    const changes: TruthPort['changes'] = (_onBatch, onDead) => {
      onDead()
      return () => {
        disposeCalls += 1
        if (disposeCalls > 1) throw new Error('dispose is not idempotent — called twice')
      }
    }
    const port = makePort({ changes })
    const client = makeClient()
    const onDegraded = vi.fn<(d: SyncDegradation) => void>()
    const engine = createSyncEngine(client, port, { onDegraded })

    await engine.populateLedger()
    expect(() => engine.start()).not.toThrow()

    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith({ kind: 'watcher-dead' })
    expect(disposeCalls).toBe(1)

    expect(() => engine.stop()).not.toThrow()
    expect(disposeCalls).toBe(1)
  })
})

describe('createSyncEngine — onDegraded: transient truth-read failure', () => {
  it('reports {kind: "path-sync-failed", stage: "truth-read"} with the original error and skips the path', async () => {
    const watch = makeWatch()
    const onDegraded = vi.fn<(d: SyncDegradation) => void>()
    const readError = new Error('port gone')
    const port = makePort({ changes: watch.changes, read: vi.fn().mockRejectedValue(readError) })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'still here' }) })
    const engine = createSyncEngine(client, port, { onDegraded })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['flaky.js'])
    await flush()

    expect(onDegraded).toHaveBeenCalledWith({
      kind: 'path-sync-failed',
      rel: 'flaky.js',
      stage: 'truth-read',
      error: readError,
    })
    expect(client.rm).not.toHaveBeenCalled()
    expect(client.write).not.toHaveBeenCalled()
  })
})

describe('createSyncEngine — onDegraded: ledger write failure while reconciling', () => {
  it('reports {kind: "path-sync-failed", stage: "reconcile"} with the original error', async () => {
    const watch = makeWatch()
    const onDegraded = vi.fn<(d: SyncDegradation) => void>()
    const writeError = new Error('ledger write failed')
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('new content')),
    })
    const client = makeClient({
      read: vi.fn().mockResolvedValue({ content: 'old content' }),
      write: vi.fn().mockRejectedValue(writeError),
    })
    const engine = createSyncEngine(client, port, { onDegraded })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['a.js'])
    await flush()

    expect(onDegraded).toHaveBeenCalledWith({
      kind: 'path-sync-failed',
      rel: 'a.js',
      stage: 'reconcile',
      error: writeError,
    })
  })
})

describe('createSyncEngine — onDegraded: a throwing host callback never wedges the engine', () => {
  it('processes a later, unrelated batch normally after onDegraded itself throws', async () => {
    const watch = makeWatch()
    const onDegraded = vi.fn<(d: SyncDegradation) => void>(() => {
      throw new Error('host callback blew up')
    })
    const readError = new Error('port gone')
    const port = makePort({
      changes: watch.changes,
      read: vi
        .fn()
        .mockRejectedValueOnce(readError)
        .mockResolvedValueOnce(new TextEncoder().encode('new content')),
    })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'old content' }) })
    const engine = createSyncEngine(client, port, { onDegraded })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['flaky.js'])
    await flush()

    expect(onDegraded).toHaveBeenCalledTimes(1)

    watch.emitBatch(['b.js'])
    await flush()

    expect(client.write).toHaveBeenCalledWith('b.js', 'new content', { actor: 'human' })
  })
})

describe('createSyncEngine — onDegraded: omitted option', () => {
  it('a host that never supplies onDegraded still gets today\'s skip/dead-watcher behavior with no crash', async () => {
    const watch = makeWatch()
    const port = makePort({ changes: watch.changes, read: vi.fn().mockRejectedValue(new Error('port gone')) })
    const client = makeClient()
    const engine = createSyncEngine(client, port)

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['flaky.js'])
    await flush()
    watch.emitDead()

    expect(client.write).not.toHaveBeenCalled()
  })
})
