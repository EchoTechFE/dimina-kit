/**
 * Contract tests for the fs-core write-ahead-log (WAL) audit wrapper around a
 * `WorkspaceSource`. The wrapper enforces these invariants:
 *
 * - A human save hits disk (`base.onSave`) first; the ledger write is a
 *   best-effort accounting step that runs after and never blocks the save,
 *   even when it rejects.
 * - An agent write is WAL-gated: the ledger write happens before the disk
 *   write, and a rejected ledger write (e.g. the fs-core turn is closed)
 *   must produce zero disk writes — the rejection propagates to the caller.
 * - Rollback restores the checkpoint before replaying any file, and touches
 *   each affected path exactly once even if it appears in multiple diff
 *   records (e.g. a move records both `from` and `to`, or a path is touched
 *   twice in the same turn). During replay only a `not-found` read means the
 *   path was deleted; any other read failure aborts the rollback.
 * - Populate reconciles ledger residue from a previous session: after the
 *   disk walk, ledger paths absent from the walked tree are removed so the
 *   ledger exactly matches the current disk tree.
 * - If the fs-core client fails to initialize, the wrapper degrades to
 *   base-only behavior: population and human saves still work, and every
 *   audit-surface method rejects with a fixed message.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSource } from './types.js'
import type { WalAuditBridge, WalAuditClientLike } from './wal-audit.js'
import { walAuditSource } from './wal-audit.js'

type SaveUri = Parameters<NonNullable<WorkspaceSource['onSave']>>[0]
type FileServiceArg = Parameters<WorkspaceSource['populate']>[0]

const fakeFileService = {} as unknown as FileServiceArg

function fakeUri(rel: string): SaveUri {
  return { toString: () => `file:///workspace/${rel}` } as unknown as SaveUri
}

function makeBase(overrides: Partial<WorkspaceSource> = {}): WorkspaceSource {
  return {
    folderUri: 'file:///workspace',
    populate: vi.fn().mockResolvedValue(0),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeBridge(overrides: Partial<WalAuditBridge> = {}): WalAuditBridge {
  return {
    readdir: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue(new Uint8Array()),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('walAuditSource — human save order (disk-first, ledger-second)', () => {
  it('runs base.onSave to completion before the ledger write starts', async () => {
    const order: string[] = []
    const base = makeBase({
      onSave: vi.fn(async () => {
        order.push('base.onSave')
      }),
    })
    const writeMock = vi.fn(async () => {
      order.push('client.write')
    })
    const client: WalAuditClientLike = {
      write: writeMock,
      rm: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      turnBegin: vi.fn().mockResolvedValue(undefined),
      turnEnd: vi.fn().mockResolvedValue(undefined),
      diff: vi.fn().mockResolvedValue({ changes: [] }),
      read: vi.fn().mockResolvedValue({ content: '' }),
      ls: vi.fn().mockResolvedValue({ paths: [] }),
      status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
      destroy: vi.fn(),
    }
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge: makeBridge(),
    })

    await source.populate(fakeFileService)
    await source.onSave!(fakeUri('a.js'), new TextEncoder().encode('content'))

    expect(order).toEqual(['base.onSave', 'client.write'])
  })
})

describe('walAuditSource — ledger-write failure never breaks a human save', () => {
  it('resolves onSave even when the accounting ledger write rejects', async () => {
    const base = makeBase()
    const client: WalAuditClientLike = {
      write: vi.fn().mockRejectedValue(new Error('ledger boom')),
      rm: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      turnBegin: vi.fn().mockResolvedValue(undefined),
      turnEnd: vi.fn().mockResolvedValue(undefined),
      diff: vi.fn().mockResolvedValue({ changes: [] }),
      read: vi.fn().mockResolvedValue({ content: '' }),
      ls: vi.fn().mockResolvedValue({ paths: [] }),
      status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
      destroy: vi.fn(),
    }
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge: makeBridge(),
    })

    await source.populate(fakeFileService)

    await expect(
      source.onSave!(fakeUri('a.js'), new TextEncoder().encode('content')),
    ).resolves.toBeUndefined()
  })
})

describe('walAuditSource — agent write is WAL-gated', () => {
  it('rejects agentWrite and performs zero disk writes when the ledger write rejects', async () => {
    const base = makeBase()
    const client: WalAuditClientLike = {
      write: vi.fn().mockRejectedValue(new Error('turn closed')),
      rm: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      turnBegin: vi.fn().mockResolvedValue(undefined),
      turnEnd: vi.fn().mockResolvedValue(undefined),
      diff: vi.fn().mockResolvedValue({ changes: [] }),
      read: vi.fn().mockResolvedValue({ content: '' }),
      ls: vi.fn().mockResolvedValue({ paths: [] }),
      status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
      destroy: vi.fn(),
    }
    const bridge = makeBridge()
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })

    await source.populate(fakeFileService)

    await expect(source.audit.agentWrite('a.js', 'content', 'turn-1')).rejects.toThrow()
    expect(bridge.write).toHaveBeenCalledTimes(0)
  })
})

describe('walAuditSource — rollback replay', () => {
  it('restores the checkpoint before replaying, touching every affected path exactly once', async () => {
    const order: string[] = []
    const base = makeBase()
    const restoreMock = vi.fn(async () => {
      order.push('restore')
    })
    const readMock = vi.fn(async (path: string) => {
      order.push(`read:${path}`)
      if (path === 'a.js' || path === 'new.js') return { content: 'X' }
      // The fs-core client surfaces its worker's error code on `error.code`;
      // only `code: 'not-found'` marks the path as deleted by the rollback.
      throw Object.assign(new Error('not found'), { code: 'not-found' })
    })
    const client: WalAuditClientLike = {
      write: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      restore: restoreMock,
      turnBegin: vi.fn().mockResolvedValue(undefined),
      turnEnd: vi.fn().mockResolvedValue(undefined),
      // A move records both `from` and `to`; `a.js` repeats across two
      // records to exercise dedup of paths touched more than once.
      diff: vi.fn().mockResolvedValue({
        cpId: 'cp-1',
        changes: [{ path: 'a.js' }, { path: 'b.js' }, { from: 'old.js', to: 'new.js' }, { path: 'a.js' }],
      }),
      read: readMock,
      ls: vi.fn().mockResolvedValue({ paths: [] }),
      status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
      destroy: vi.fn(),
    }
    const bridge = makeBridge()
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })

    await source.populate(fakeFileService)
    await source.audit.rollback('turn-1')

    expect(restoreMock).toHaveBeenCalledWith('cp-1')
    expect(order[0]).toBe('restore')
    expect(order.slice(1).every((entry) => entry.startsWith('read:'))).toBe(true)

    // Four unique affected paths: a.js, b.js, old.js, new.js.
    expect(readMock).toHaveBeenCalledTimes(4)
    const readPaths = readMock.mock.calls.map((call) => call[0]).sort()
    expect(readPaths).toEqual(['a.js', 'b.js', 'new.js', 'old.js'])

    expect(bridge.write).toHaveBeenCalledTimes(2)
    expect(bridge.delete).toHaveBeenCalledTimes(2)
    expect(bridge.write).toHaveBeenCalledWith(expect.any(String), 'a.js', new TextEncoder().encode('X'))
    expect(bridge.write).toHaveBeenCalledWith(expect.any(String), 'new.js', new TextEncoder().encode('X'))
    expect(bridge.delete).toHaveBeenCalledWith(expect.any(String), 'b.js')
    expect(bridge.delete).toHaveBeenCalledWith(expect.any(String), 'old.js')
  })
})

describe('walAuditSource — rollback replay distinguishes deletion from transient read failure', () => {
  it('rejects rollback and deletes nothing when a replay read fails with a non-not-found error', async () => {
    const base = makeBase()
    const client: WalAuditClientLike = {
      write: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      turnBegin: vi.fn().mockResolvedValue(undefined),
      turnEnd: vi.fn().mockResolvedValue(undefined),
      diff: vi.fn().mockResolvedValue({ cpId: 'cp-1', changes: [{ path: 'a.js' }] }),
      // Only a read rejection with code 'not-found' means "path deleted by
      // the rollback"; any other failure (worker crash, timeout) must abort
      // the replay instead of being mistaken for a deletion.
      read: vi.fn().mockRejectedValue(Object.assign(new Error('worker gone'), { code: 'fatal' })),
      ls: vi.fn().mockResolvedValue({ paths: [] }),
      status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
      destroy: vi.fn(),
    }
    const bridge = makeBridge()
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })

    await source.populate(fakeFileService)

    await expect(source.audit.rollback('turn-1')).rejects.toThrow()
    expect(bridge.delete).toHaveBeenCalledTimes(0)
    expect(bridge.write).toHaveBeenCalledTimes(0)
  })
})

describe('walAuditSource — populate reconciles ledger residue', () => {
  it('removes ledger paths absent from the walked disk tree and keeps paths that still exist', async () => {
    const base = makeBase()
    // The OPFS ledger persists across sessions under a fixed projectId; after
    // populate the ledger must exactly match the current disk tree.
    const rmMock = vi.fn().mockResolvedValue(undefined)
    const client: WalAuditClientLike = {
      write: vi.fn().mockResolvedValue(undefined),
      rm: rmMock,
      restore: vi.fn().mockResolvedValue(undefined),
      turnBegin: vi.fn().mockResolvedValue(undefined),
      turnEnd: vi.fn().mockResolvedValue(undefined),
      diff: vi.fn().mockResolvedValue({ changes: [] }),
      read: vi.fn().mockResolvedValue({ content: '' }),
      ls: vi.fn().mockResolvedValue({ paths: ['a.js', 'stale-from-old-project.js'] }),
      status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
      destroy: vi.fn(),
    }
    // The walk yields a single root-level file; any nested readdir is empty.
    const bridge = makeBridge({
      readdir: vi.fn(async (_baseUrl: string, rel: string) =>
        rel === '' || rel === '.' || rel === '/' ? [['a.js', 1] as [string, number]] : [],
      ),
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('content')),
    })
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })

    await source.populate(fakeFileService)

    expect(rmMock).toHaveBeenCalledWith(
      'stale-from-old-project.js',
      expect.objectContaining({ actor: 'human' }),
    )
    const removedPaths = rmMock.mock.calls.map((call) => call[0])
    expect(removedPaths).not.toContain('a.js')
  })
})

describe('walAuditSource — graceful degradation when the fs-core client fails to initialize', () => {
  it('keeps base population and human saves working, and rejects every audit-surface call', async () => {
    const base = makeBase({ populate: vi.fn().mockResolvedValue(42) })
    const bridge = makeBridge()
    const source = walAuditSource(base, {
      fsBaseUrl: 'https://fs.example',
      createClient: () => Promise.reject(new Error('opfs unavailable')),
      bridge,
    })

    const count = await source.populate(fakeFileService)
    expect(count).toBe(42)
    expect(base.populate).toHaveBeenCalledTimes(1)

    await expect(
      source.onSave!(fakeUri('a.js'), new TextEncoder().encode('content')),
    ).resolves.toBeUndefined()
    expect(base.onSave).toHaveBeenCalledTimes(1)

    await expect(source.audit.beginTurn('t1')).rejects.toEqual(new Error('wal audit unavailable'))
    await expect(source.audit.agentWrite('a.js', 'x', 't1')).rejects.toEqual(
      new Error('wal audit unavailable'),
    )
    await expect(source.audit.endTurn('t1')).rejects.toThrow()
    await expect(source.audit.agentRm('a.js', 't1')).rejects.toThrow()
    await expect(source.audit.diff('t1')).rejects.toThrow()
    await expect(source.audit.rollback('t1')).rejects.toThrow()
  })
})

describe('walAuditSource — truth-write failure compensation (ledger must not fork from disk)', () => {
  function makeCompClient(overrides: Partial<WalAuditClientLike> = {}): WalAuditClientLike {
    return {
      write: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      turnBegin: vi.fn().mockResolvedValue(undefined),
      turnEnd: vi.fn().mockResolvedValue(undefined),
      diff: vi.fn().mockResolvedValue({ changes: [] }),
      read: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 'not-found' })),
      ls: vi.fn().mockResolvedValue({ paths: [] }),
      status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
      destroy: vi.fn(),
      ...overrides,
    }
  }

  it('agentWrite: a bridge failure (e.g. 413 oversize) rolls the NEW ledger record back out via rm', async () => {
    const client = makeCompClient() // read → not-found: the path did not exist before
    const bridge = makeBridge({ write: vi.fn().mockRejectedValue(Object.assign(new Error('413'), { status: 413 })) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })
    await source.populate(fakeFileService)

    await expect(source.audit.agentWrite('big.bin', 'x'.repeat(64), 't-1')).rejects.toThrow('413')
    expect(client.write).toHaveBeenCalledWith('big.bin', 'x'.repeat(64), { actor: 'agent', turnId: 't-1' })
    // Compensation: the path had no prior record, so the forked record is removed.
    expect(client.rm).toHaveBeenCalledWith('big.bin', { actor: 'agent', turnId: 't-1' })
  })

  it('agentWrite: a bridge failure on an EXISTING path writes the prior content back', async () => {
    const client = makeCompClient({ read: vi.fn().mockResolvedValue({ content: 'prior content' }) })
    const bridge = makeBridge({ write: vi.fn().mockRejectedValue(new Error('disk full')) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })
    await source.populate(fakeFileService)

    await expect(source.audit.agentWrite('a.js', 'new content', 't-1')).rejects.toThrow('disk full')
    const writes = (client.write as ReturnType<typeof vi.fn>).mock.calls
    expect(writes).toContainEqual(['a.js', 'new content', { actor: 'agent', turnId: 't-1' }])
    expect(writes[writes.length - 1]).toEqual(['a.js', 'prior content', { actor: 'agent', turnId: 't-1' }])
    expect(client.rm).not.toHaveBeenCalled()
  })

  it('agentRm: a bridge delete failure writes the removed record back', async () => {
    const client = makeCompClient({ read: vi.fn().mockResolvedValue({ content: 'still on disk' }) })
    const bridge = makeBridge({ delete: vi.fn().mockRejectedValue(new Error('EACCES')) })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })
    await source.populate(fakeFileService)

    await expect(source.audit.agentRm('a.js', 't-1')).rejects.toThrow('EACCES')
    expect(client.rm).toHaveBeenCalledWith('a.js', { actor: 'agent', turnId: 't-1' })
    expect(client.write).toHaveBeenCalledWith('a.js', 'still on disk', { actor: 'agent', turnId: 't-1' })
  })

  it('rollback: one path failing its disk replay does not strand the others, and the error names it', async () => {
    const client = makeCompClient({
      diff: vi.fn().mockResolvedValue({
        cpId: 'cp-1',
        changes: [{ path: 'ok-1.js' }, { path: 'bad.js' }, { path: 'ok-2.js' }],
      }),
      read: vi.fn().mockImplementation((rel: string) => Promise.resolve({ content: `restored ${rel}` })),
    })
    const bridge = makeBridge({
      write: vi.fn().mockImplementation((_base: string, rel: string) =>
        rel === 'bad.js' ? Promise.reject(new Error('bridge down for bad.js')) : Promise.resolve(undefined),
      ),
    })
    const source = walAuditSource(makeBase(), {
      fsBaseUrl: 'https://fs.example',
      createClient: vi.fn().mockResolvedValue(client),
      bridge,
    })
    await source.populate(fakeFileService)

    await expect(source.audit.rollback('t-1')).rejects.toThrow(/bad\.js/)
    expect(client.restore).toHaveBeenCalledWith('cp-1')
    // Both healthy paths were still replayed to disk despite bad.js failing.
    const written = (bridge.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(written).toContain('ok-1.js')
    expect(written).toContain('ok-2.js')
  })
})
