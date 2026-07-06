/**
 * Contract tests for `createSyncEngine` — the engine extracted from
 * dimina-kit workbench's `wal-audit.ts` (devtools-fs-core-feasibility.md
 * §7+§8). These replay, against fake `client`/`port` doubles, the SAME six
 * disk<->editor sync scenarios workbench's `disk-sync.test.ts` covers against
 * `walAuditSource` — the equivalence judge for this extraction: the engine
 * must produce byte-identical observable behavior (ledger writes/rms,
 * `applyToEditor` calls) for the same inputs.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSyncEngine } from './sync-engine.js'
import type { SyncClientLike } from './sync-engine.js'
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

describe('createSyncEngine — disk sync: external new content', () => {
  it('records the change and refreshes the editor exactly once', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('new content')),
    })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'old content' }) })
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['a.js'])
    await flush()

    expect(client.write).toHaveBeenCalledTimes(1)
    expect(client.write).toHaveBeenCalledWith('a.js', 'new content', { actor: 'human' })
    expect(applyToEditor).toHaveBeenCalledTimes(1)
    expect(applyToEditor).toHaveBeenCalledWith('a.js', new TextEncoder().encode('new content'))
  })
})

describe('createSyncEngine — disk sync: echo absorption', () => {
  it('performs zero ledger writes and zero editor refreshes when content matches the ledger', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('same content')),
    })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'same content' }) })
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['a.js'])
    await flush()

    expect(client.write).toHaveBeenCalledTimes(0)
    expect(client.rm).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(0)
  })
})

describe('createSyncEngine — disk sync: external delete', () => {
  it('removes the path from the ledger and applies a null delete to the editor', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    // Only a not-found rejection (status 404, per the TruthPort error
    // contract) may be read as a deletion.
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockRejectedValue(Object.assign(new Error('read gone.js: 404'), { status: 404 })),
    })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'was here' }) })
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['gone.js'])
    await flush()

    expect(client.rm).toHaveBeenCalledTimes(1)
    expect(client.rm).toHaveBeenCalledWith('gone.js', { actor: 'human' })
    expect(applyToEditor).toHaveBeenCalledTimes(1)
    expect(applyToEditor).toHaveBeenCalledWith('gone.js', null)
  })
})

describe('createSyncEngine — disk sync: transient port failure ("unavailable")', () => {
  it('skips the path — no ledger rm, no ledger write, no editor apply', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    // No `status`/`code` on the rejection (worker crash / network hiccup
    // shape) — must NOT be classified as not-found.
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockRejectedValue(new Error('port gone')),
    })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'still here' }) })
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['flaky.js'])
    await flush()

    expect(client.rm).toHaveBeenCalledTimes(0)
    expect(client.write).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(0)
  })
})

describe('createSyncEngine — disk sync: dead watcher', () => {
  it('stops processing events once onDead fires', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
    })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'different' }) })
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitDead()
    watch.emitBatch(['a.js'])
    await flush()

    expect(client.write).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(0)
  })
})

describe('createSyncEngine — outbound echo consolidation on save', () => {
  it('skips the ledger write when the saved content already matches the ledger record', async () => {
    const port = makePort()
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'already recorded' }) })
    const engine = createSyncEngine(client, port)

    await engine.populateLedger()
    await engine.onHumanSave('a.js', 'already recorded')

    expect(client.write).toHaveBeenCalledTimes(0)
  })
})

describe('createSyncEngine — populateLedger reconciles ledger residue', () => {
  it('removes ledger paths absent from the walked tree and keeps paths that still exist', async () => {
    const rmMock = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({
      rm: rmMock,
      ls: vi.fn().mockResolvedValue({ paths: ['a.js', 'stale-from-old-project.js'] }),
    })
    const port = makePort({
      walk: vi.fn(async (onFile: (rel: string, bytes: Uint8Array) => Promise<void>) => {
        await onFile('a.js', new TextEncoder().encode('content'))
      }),
    })
    const engine = createSyncEngine(client, port)

    await engine.populateLedger()

    expect(rmMock).toHaveBeenCalledWith('stale-from-old-project.js', expect.objectContaining({ actor: 'human' }))
    const removedPaths = rmMock.mock.calls.map((call) => call[0])
    expect(removedPaths).not.toContain('a.js')
  })
})

describe('createSyncEngine — pendingWrite is a structural no-op for a push port', () => {
  it('an in-flight onHumanSave never lets a same-path inbound batch observe a pendingWrite hit', async () => {
    // Both onHumanSave and an inbound batch enqueue onto the SAME ledgerTurn
    // FIFO. Registering pendingWrite happens synchronously when onHumanSave
    // is called, and it is cleared inside onHumanSave's own queued turn —
    // strictly before any LATER-queued inbound turn for the same path can
    // run. This test proves that guarantee: even when onHumanSave's ledger
    // write is deliberately slow, a same-path inbound batch queued right
    // after it still falls through to ordinary content comparison (the disk
    // content differs from the ledger's post-save record), not a
    // pendingWrite short-circuit.
    let resolveWrite: () => void = () => {}
    const writeGate = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    const client = makeClient({
      read: vi.fn().mockResolvedValue({ content: 'old' }),
      write: vi.fn(async () => {
        await writeGate
      }),
    })
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const watch = makeWatch()
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('externally new')),
    })
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()

    const savePromise = engine.onHumanSave('a.js', 'new from human')
    // Queue an inbound batch for the SAME path while the save's ledger write
    // is still gated open.
    watch.emitBatch(['a.js'])
    resolveWrite()
    await savePromise
    await flush()

    // If the inbound turn had observed a pendingWrite hit, it would have
    // absorbed the batch silently (zero client.write / applyToEditor calls
    // for 'a.js' beyond the save itself). Instead it ran AFTER onHumanSave's
    // turn cleared pendingWrite, fell through to ordinary content
    // comparison (ledger's mocked, unchanged 'old' record vs. the port's
    // 'externally new' bytes), and recorded + applied the inbound change —
    // proving the pendingWrite branch is a structural no-op for this push
    // port, exactly as it is for the real devtools adapter.
    expect(client.write).toHaveBeenCalledWith('a.js', 'new from human', { actor: 'human' })
    expect(client.write).toHaveBeenCalledWith('a.js', 'externally new', { actor: 'human' })
    expect(applyToEditor).toHaveBeenCalledWith('a.js', new TextEncoder().encode('externally new'))
  })
})
