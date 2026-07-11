/**
 * Contract tests for `walAuditSource`'s disk↔editor sync engine: the ledger
 * arbitrates whether an inbound `/__fs/watch` batch is genuinely new content
 * or the echo of our own last write, and a dead watcher stops the
 * subscription for good.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSource } from './types.js'
import type { WalAuditBridge, WalAuditClientLike } from './wal-audit.js'
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
    // Real-contract shape: `/__fs/readdir` succeeds only for directories —
    // on a file path it rejects (ENOTDIR -> 500). The watch-batch directory
    // expansion (wal-audit.ts's expandWatchBatch) relies on that rejection to
    // classify a non-ledger path as a plain file; a readdir that resolves []
    // for EVERY path would make it swallow file events as "empty directory".
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

/** Flush the microtask queue enough times for a batch's chained bridge/ledger
 * reads+writes to settle before assertions run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('walAuditSource — disk sync: external new content', () => {
  it('records the change and refreshes the editor exactly once', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bridge = makeBridge({ read: vi.fn().mockResolvedValue(new TextEncoder().encode('new content')) })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'old content' }) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
      watchEvents: watch.watchEvents,
      applyToEditor,
    })

    await source.populate(fakeFileService)
    watch.emitBatch(['a.js'])
    await flush()

    expect(client.write).toHaveBeenCalledTimes(1)
    expect(client.write).toHaveBeenCalledWith('a.js', 'new content', { actor: 'human' })
    expect(applyToEditor).toHaveBeenCalledTimes(1)
    expect(applyToEditor).toHaveBeenCalledWith('a.js', new TextEncoder().encode('new content'))
  })
})

describe('walAuditSource — disk sync: echo absorption', () => {
  it('performs zero ledger writes and zero editor refreshes when content matches the ledger', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bridge = makeBridge({ read: vi.fn().mockResolvedValue(new TextEncoder().encode('same content')) })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'same content' }) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
      watchEvents: watch.watchEvents,
      applyToEditor,
    })

    await source.populate(fakeFileService)
    watch.emitBatch(['a.js'])
    await flush()

    expect(client.write).toHaveBeenCalledTimes(0)
    expect(client.rm).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(0)
  })
})

describe('walAuditSource — disk sync: external delete', () => {
  it('removes the path from the ledger and applies a null delete to the editor', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    // The real bridgeRead attaches the HTTP status; only 404 (ENOENT) may be
    // read as a deletion.
    const bridge = makeBridge({
      read: vi.fn().mockRejectedValue(Object.assign(new Error('read gone.js: 404'), { status: 404 })),
    })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'was here' }) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
      watchEvents: watch.watchEvents,
      applyToEditor,
    })

    await source.populate(fakeFileService)
    watch.emitBatch(['gone.js'])
    await flush()

    expect(client.rm).toHaveBeenCalledTimes(1)
    expect(client.rm).toHaveBeenCalledWith('gone.js', { actor: 'human' })
    expect(applyToEditor).toHaveBeenCalledTimes(1)
    expect(applyToEditor).toHaveBeenCalledWith('gone.js', null)
  })
})

describe('walAuditSource — disk sync: transient bridge failure', () => {
  it('skips the path — no ledger rm, no ledger write, no editor apply', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    // No `status` on the rejection (worker crash / network hiccup shape) —
    // must NOT be interpreted as a deletion.
    const bridge = makeBridge({ read: vi.fn().mockRejectedValue(new Error('bridge gone')) })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'still here' }) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
      watchEvents: watch.watchEvents,
      applyToEditor,
    })

    await source.populate(fakeFileService)
    watch.emitBatch(['flaky.js'])
    await flush()

    expect(client.rm).toHaveBeenCalledTimes(0)
    expect(client.write).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(0)
  })
})

describe('walAuditSource — disk sync: dead watcher', () => {
  it('stops processing events once onDead fires', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bridge = makeBridge({ read: vi.fn().mockResolvedValue(new TextEncoder().encode('content')) })
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'different' }) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
      watchEvents: watch.watchEvents,
      applyToEditor,
    })

    await source.populate(fakeFileService)
    watch.emitDead()
    watch.emitBatch(['a.js'])
    await flush()

    expect(client.write).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(0)
  })
})

describe('walAuditSource — outbound echo consolidation on save', () => {
  it('skips the ledger write when the saved content already matches the ledger record', async () => {
    const base = makeBase()
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'already recorded' }) })
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge: makeBridge(),
    })

    await source.populate(fakeFileService)
    await source.onSave!(
      { toString: () => 'file:///workspace/a.js' } as unknown as Parameters<NonNullable<WorkspaceSource['onSave']>>[0],
      new TextEncoder().encode('already recorded'),
    )

    expect(base.onSave).toHaveBeenCalledTimes(1)
    expect(client.write).toHaveBeenCalledTimes(0)
  })
})

describe('walAuditSource — disk sync: file replaced by a same-named directory', () => {
  it('retires the stale ledger FILE record (bridge EISDIR→404) and ingests the new subtree', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const dirFileBytes = new TextEncoder().encode('dir file')
    const bridge = makeBridge({
      // Disk state AFTER the replacement: `foo` is a directory holding bar.js.
      readdir: vi.fn().mockImplementation((_baseUrl: string, rel: string) => {
        if (rel === '.' || rel === '') return Promise.resolve([['foo', 2]])
        if (rel === 'foo') return Promise.resolve([['bar.js', 1]])
        return Promise.reject(new Error(`ENOTDIR: not a directory: ${rel}`))
      }),
      read: vi.fn().mockImplementation((_baseUrl: string, rel: string) => {
        // Reading `foo` itself: it is a directory now — the real bridge maps
        // EISDIR to HTTP 404 (workbench-coi-server.ts's fsErrorStatus).
        if (rel === 'foo') return Promise.reject(Object.assign(new Error('EISDIR'), { status: 404 }))
        if (rel === 'foo/bar.js') return Promise.resolve(dirFileBytes)
        return Promise.reject(Object.assign(new Error('not found'), { status: 404 }))
      }),
    })
    const client = makeClient({
      ls: vi.fn().mockResolvedValue({ paths: ['foo'] }), // ledger still thinks `foo` is a FILE
      read: vi.fn().mockImplementation((rel: string) => {
        if (rel === 'foo') return Promise.resolve({ content: 'old file content' })
        return Promise.reject(Object.assign(new Error('not found'), { code: 'not-found' }))
      }),
    })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example/',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
      watchEvents: watch.watchEvents,
      applyToEditor,
    })

    await source.populate(fakeFileService)
    ;(client.write as ReturnType<typeof vi.fn>).mockClear()
    ;(client.rm as ReturnType<typeof vi.fn>).mockClear()
    applyToEditor.mockClear()

    // The watcher names only the parent path — expansion must probe it even
    // though the ledger knows `foo` as a file (the skip-known-files shortcut
    // was exactly the hole that dropped the new subtree).
    watch.emitBatch(['foo'])

    await vi.waitFor(() => {
      expect(client.rm).toHaveBeenCalledWith('foo', { actor: 'human' })
      expect(client.write).toHaveBeenCalledWith('foo/bar.js', 'dir file', { actor: 'human' })
    })
    expect(applyToEditor).toHaveBeenCalledWith('foo', null)
    expect(applyToEditor).toHaveBeenCalledWith('foo/bar.js', dirFileBytes)
  })
})
