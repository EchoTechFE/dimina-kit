/**
 * Contract tests for `walAuditSource`'s `onDegraded` reporting: an
 * `initLedger()` failure (OPFS/worker init rejects, degrading to disk-only)
 * and a `watcher-dead` event forwarded up from the underlying sync engine
 * must both surface through the host-supplied `onDegraded` callback instead
 * of only a `console.warn`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSource } from './types.js'
import type { WalAuditBridge, WalAuditClientLike, WalAuditDegradation } from './wal-audit.js'
import { walAuditSource } from './wal-audit.js'

type FileServiceArg = Parameters<WorkspaceSource['populate']>[0]
const fakeFileService = {} as unknown as FileServiceArg

function makeBase(): WorkspaceSource {
  return {
    folderUri: 'file:///workspace',
    populate: vi.fn().mockResolvedValue(0),
    onSave: vi.fn().mockResolvedValue(undefined),
  }
}

function makeBridge(overrides: Partial<WalAuditBridge> = {}): WalAuditBridge {
  return {
    readdir: vi.fn().mockImplementation((_baseUrl: string, rel: string) =>
      rel === '.' || rel === ''
        ? Promise.resolve([])
        : Promise.reject(new Error(`ENOTDIR: not a directory: ${rel}`)),
    ),
    read: vi.fn().mockResolvedValue(new Uint8Array()),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeClient(overrides: Partial<WalAuditClientLike> = {}): WalAuditClientLike {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    turnBegin: vi.fn().mockResolvedValue(undefined),
    turnEnd: vi.fn().mockResolvedValue(undefined),
    diff: vi.fn().mockResolvedValue({ changes: [] }),
    read: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'not-found' })),
    ls: vi.fn().mockResolvedValue({ paths: [] }),
    status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
    destroy: vi.fn(),
    ...overrides,
  }
}

/** Fake `watchEvents`: captures the `onBatch`/`onDead` callbacks `startSync`
 * registers and exposes them as `emitBatch`/`emitDead`, so a test can drive
 * the sync engine without a real `EventSource`/SSE round trip. */
function makeWatch(): {
  watchEvents: (onBatch: (paths: string[]) => void, onDead: () => void) => () => void
  stop: ReturnType<typeof vi.fn>
  emitBatch: (paths: string[]) => void
  emitDead: () => void
} {
  let batchHandler: (paths: string[]) => void = () => {}
  let deadHandler: () => void = () => {}
  const stop = vi.fn()
  const watchEvents = (onBatch: (paths: string[]) => void, onDead: () => void): (() => void) => {
    batchHandler = onBatch
    deadHandler = onDead
    return stop
  }
  return {
    watchEvents,
    stop,
    emitBatch: (paths) => batchHandler(paths),
    emitDead: () => deadHandler(),
  }
}

describe('walAuditSource — onDegraded: ledger init failure', () => {
  it('reports {kind: "ledger-unavailable"} with the original error and still falls back to disk-only behavior', async () => {
    const onDegraded = vi.fn<(d: WalAuditDegradation) => void>()
    const clientError = new Error('OPFS init failed')
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockRejectedValue(clientError),
      bridge: makeBridge(),
      onDegraded,
    })

    await source.populate(fakeFileService)

    expect(onDegraded).toHaveBeenCalledWith({ kind: 'ledger-unavailable', error: clientError })
    // The pre-existing disk-only fallback this test must not regress.
    await expect(source.audit.status()).rejects.toThrow('wal audit unavailable')
  })
})

describe('walAuditSource — onDegraded: watcher-dead forwarded from the sync engine', () => {
  it('reports the sync engine\'s {kind: "watcher-dead"} degradation through this layer\'s onDegraded', async () => {
    const watch = makeWatch()
    const onDegraded = vi.fn<(d: WalAuditDegradation) => void>()
    const client = makeClient()
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge: makeBridge(),
      watchEvents: watch.watchEvents,
      onDegraded,
    })

    await source.populate(fakeFileService)
    watch.emitDead()

    expect(onDegraded).toHaveBeenCalledWith({ kind: 'watcher-dead' })
  })
})
