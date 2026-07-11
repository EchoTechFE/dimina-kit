/**
 * Contract tests for `createSyncEngine`. These replay, against fake
 * `client`/`port` doubles, the SAME six disk<->editor sync scenarios
 * workbench's `disk-sync.test.ts` covers against `walAuditSource` — the
 * cross-package equivalence judge: the engine must produce byte-identical
 * observable behavior (ledger writes/rms, `applyToEditor` calls) for the
 * same inputs as the wal-audit layer built on it.
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

describe('createSyncEngine — ledgerTurn FIFO orders an in-flight save before a same-path inbound batch', () => {
  it('a same-path inbound batch queued behind a slow onHumanSave still gets content-compared and recorded', async () => {
    // Both onHumanSave and an inbound batch enqueue onto the SAME ledgerTurn
    // FIFO, so a later-queued inbound turn for the same path always runs
    // AFTER the save's ledger write completed. This test proves that
    // guarantee: even when onHumanSave's ledger write is deliberately slow,
    // a same-path inbound batch queued right after it is judged by ordinary
    // content comparison against the post-save ledger record (the disk
    // content differs, so it must be recorded) — never silently absorbed as
    // the save's own echo.
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

    // If the inbound turn had been misjudged as the save's echo, it would
    // have been absorbed silently (zero client.write / applyToEditor calls
    // for 'a.js' beyond the save itself). Instead it ran AFTER onHumanSave's
    // queued turn, was content-compared (ledger's mocked, unchanged 'old'
    // record vs. the port's 'externally new' bytes), and recorded + applied
    // the inbound change.
    expect(client.write).toHaveBeenCalledWith('a.js', 'new from human', { actor: 'human' })
    expect(client.write).toHaveBeenCalledWith('a.js', 'externally new', { actor: 'human' })
    expect(applyToEditor).toHaveBeenCalledWith('a.js', new TextEncoder().encode('externally new'))
  })
})

describe('createSyncEngine — binary layering: sniff boundary', () => {
  it('classifies a NUL inside the first 8192 bytes as binary but a NUL beyond it as text', async () => {
    const withinSniff = new Uint8Array(100).fill(65) // 'A'
    withinSniff[50] = 0
    const beyondSniff = new Uint8Array(8192 + 10).fill(65)
    beyondSniff[8192 + 5] = 0 // NUL sits outside the first 8192 bytes

    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const port = makePort({
      changes: watch.changes,
      read: vi
        .fn()
        .mockResolvedValueOnce(withinSniff)
        .mockResolvedValueOnce(beyondSniff),
    })
    const client = makeClient({ read: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'not-found' })) })
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['within.bin'])
    // sha256hex uses the real crypto.subtle.digest — a genuinely async
    // native op, not a same-tick mock resolution like the rest of this
    // file's fakes, so a single `flush()` macrotask isn't a reliable wait.
    // Poll instead of guessing a fixed extra delay.
    await vi.waitFor(() => expect(applyToEditor).toHaveBeenCalledWith('within.bin', withinSniff))
    watch.emitBatch(['beyond.txt'])
    await vi.waitFor(() => expect(client.write).toHaveBeenCalledWith('beyond.txt', expect.any(String), { actor: 'human' }))

    // within.bin: NUL inside the sniff window — binary path, ledger untouched, editor gets raw bytes.
    expect(client.write).toHaveBeenCalledTimes(1) // only beyond.txt goes through the text path
    // beyond.txt: NUL outside the sniff window — treated as text (decoded, possibly with a replacement char).
    expect(applyToEditor).toHaveBeenCalledWith('beyond.txt', beyondSniff)
  })
})

describe('createSyncEngine — binary layering: inbound new/changed binary content', () => {
  it('does not touch the ledger, updates binaryIndex, and applies the raw bytes to the editor exactly once', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bytes = new Uint8Array([0, 1, 2, 3, 4])
    const port = makePort({ changes: watch.changes, read: vi.fn().mockResolvedValue(bytes) })
    const client = makeClient()
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['image.png'])
    await vi.waitFor(() => expect(applyToEditor).toHaveBeenCalledTimes(1))

    expect(client.write).toHaveBeenCalledTimes(0)
    expect(client.read).not.toHaveBeenCalledWith('image.png')
    expect(applyToEditor).toHaveBeenCalledWith('image.png', bytes)
  })
})

describe('createSyncEngine — binary layering: inbound echo (identical hash+size)', () => {
  it('performs zero actions when the same binary bytes are observed again', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bytes = new Uint8Array([0, 9, 8, 7])
    const port = makePort({ changes: watch.changes, read: vi.fn().mockResolvedValue(bytes) })
    const client = makeClient()
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['image.png'])
    await vi.waitFor(() => expect(applyToEditor).toHaveBeenCalledTimes(1))
    applyToEditor.mockClear()

    // Same bytes observed again (e.g. a duplicate/coalesced fs event) — same size+hash, so it's an echo.
    watch.emitBatch(['image.png'])
    await flush()

    expect(client.write).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(0)
  })
})

describe('createSyncEngine — binary layering: inbound deletion', () => {
  it('applies a null delete to the editor and does not call client.rm for a binaryIndex-only path', async () => {
    const watch = makeWatch()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const bytes = new Uint8Array([0, 1, 2, 3])
    const port = makePort({
      changes: watch.changes,
      read: vi.fn().mockResolvedValueOnce(bytes).mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 })),
    })
    const client = makeClient()
    const engine = createSyncEngine(client, port, { applyToEditor })

    await engine.populateLedger()
    engine.start()
    watch.emitBatch(['image.png']) // first observed: enters binaryIndex
    await vi.waitFor(() => expect(applyToEditor).toHaveBeenCalledTimes(1))
    applyToEditor.mockClear()

    watch.emitBatch(['image.png']) // now deleted at the truth source
    await flush()

    expect(client.rm).toHaveBeenCalledTimes(0)
    expect(applyToEditor).toHaveBeenCalledTimes(1)
    expect(applyToEditor).toHaveBeenCalledWith('image.png', null)
  })
})

describe('createSyncEngine — binary layering: onHumanSave with binary content', () => {
  it('skips the ledger write and does not call applyToEditor for a binary save', async () => {
    const port = makePort()
    const client = makeClient()
    const engine = createSyncEngine(client, port)

    await engine.populateLedger()
    await engine.onHumanSave('image.png', new Uint8Array([0, 1, 2, 3]))

    expect(client.write).toHaveBeenCalledTimes(0)
  })

  it('still records a plain-string save exactly as before (text path unaffected)', async () => {
    const port = makePort()
    const client = makeClient({ read: vi.fn().mockResolvedValue({ content: 'old' }) })
    const engine = createSyncEngine(client, port)

    await engine.populateLedger()
    await engine.onHumanSave('a.js', 'new text')

    expect(client.write).toHaveBeenCalledWith('a.js', 'new text', { actor: 'human' })
  })
})

/** Stateful world for contention tests: a truth-source `disk` and a ledger
 * that actually HOLD content, so interleaving tests can assert final-state
 * convergence (ledger == disk) instead of just call counts. `ledgerWrites`
 * records every (rel, text) the engine committed, in order — the lost-update
 * detector: a value that should have been recorded exactly once must appear
 * exactly once, an echo must not appear at all. */
function makeStatefulWorld(initialDisk: Record<string, string> = {}) {
  const encoder = new TextEncoder()
  const disk = new Map<string, Uint8Array>(
    Object.entries(initialDisk).map(([rel, text]) => [rel, encoder.encode(text)]),
  )
  const ledger = new Map<string, string>()
  const ledgerWrites: Array<[string, string]> = []
  const client: SyncClientLike = {
    write: vi.fn(async (rel: string, text: string) => {
      ledger.set(rel, text)
      ledgerWrites.push([rel, text])
    }),
    rm: vi.fn(async (rel: string) => {
      ledger.delete(rel)
    }),
    read: vi.fn(async (rel: string) => {
      if (!ledger.has(rel)) throw Object.assign(new Error('not in ledger'), { code: 'not-found' })
      return { content: ledger.get(rel) as string }
    }),
    ls: vi.fn(async () => ({ paths: [...ledger.keys()] })),
  }
  const watch = makeWatch()
  const port = makePort({
    capabilities: { watch: 'poll' },
    read: vi.fn(async (rel: string) => {
      const bytes = disk.get(rel)
      if (!bytes) throw Object.assign(new Error('not on disk'), { code: 'not-found' })
      return bytes
    }),
    walk: vi.fn(async (onFile: (rel: string, bytes: Uint8Array) => Promise<void>) => {
      for (const [rel, bytes] of disk) await onFile(rel, bytes)
    }),
    changes: watch.changes,
  })
  return {
    disk,
    ledger,
    ledgerWrites,
    client,
    port,
    watch,
    setDisk(rel: string, text: string) {
      disk.set(rel, encoder.encode(text))
    },
    delDisk(rel: string) {
      disk.delete(rel)
    },
  }
}

describe('createSyncEngine — extreme contention: bidirectional same-path churn', () => {
  it('converges ledger == disk with no lost update and no echo re-record across an inbound/save/inbound interleave', async () => {
    const w = makeStatefulWorld({ 'f.js': 'v1' })
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const engine = createSyncEngine(w.client, w.port, { applyToEditor })

    await engine.populateLedger() // seeds v1
    engine.start()

    // Human save: per the host contract the truth source is written FIRST,
    // then onHumanSave records. The scanner may then report that same disk
    // mtime change — the echo the engine must absorb.
    w.setDisk('f.js', 'v2-human')
    await engine.onHumanSave('f.js', 'v2-human')
    w.watch.emitBatch(['f.js']) // poll echo of our own save

    // External edit races right behind the echo.
    w.setDisk('f.js', 'v3-external')
    w.watch.emitBatch(['f.js'])

    await vi.waitFor(() => expect(w.ledger.get('f.js')).toBe('v3-external'))

    // Convergence: ledger text == disk bytes.
    expect(new TextDecoder().decode(w.disk.get('f.js'))).toBe('v3-external')
    // No lost update, no duplicate: seed v1, save v2, inbound v3 — each once.
    expect(w.ledgerWrites.filter(([rel]) => rel === 'f.js').map(([, text]) => text)).toEqual([
      'v1',
      'v2-human',
      'v3-external',
    ])
    // The echo batch produced no editor apply; the external edit produced one.
    expect(applyToEditor).toHaveBeenCalledTimes(1)
    expect(applyToEditor).toHaveBeenCalledWith('f.js', expect.anything())
  })

  it('serializes an inbound batch against an in-flight onHumanSave ledger write on the same path (FIFO, no interleaved corruption)', async () => {
    const w = makeStatefulWorld({ 'f.js': 'v1' })
    // Hold the save's ledger write mid-flight so the inbound batch provably
    // queues BEHIND it rather than interleaving.
    let releaseSave!: () => void
    const gate = new Promise<void>((r) => {
      releaseSave = r
    })
    const realWrite = w.client.write as ReturnType<typeof vi.fn>
    let held = false
    realWrite.mockImplementation(async (rel: string, text: string) => {
      if (!held && text === 'v2-human') {
        held = true
        await gate
      }
      w.ledger.set(rel, text)
      w.ledgerWrites.push([rel, text])
    })
    const engine = createSyncEngine(w.client, w.port)

    await engine.populateLedger()
    engine.start()

    w.setDisk('f.js', 'v2-human')
    const savePromise = engine.onHumanSave('f.js', 'v2-human') // blocks on gate inside its FIFO slot
    w.setDisk('f.js', 'v-ext') // external write lands while the save is still in flight
    w.watch.emitBatch(['f.js'])

    await new Promise((r) => setTimeout(r, 20)) // give the batch every chance to (wrongly) overtake
    expect(w.ledger.get('f.js')).toBe('v1') // nothing committed while the save holds the FIFO

    releaseSave()
    await savePromise
    await vi.waitFor(() => expect(w.ledger.get('f.js')).toBe('v-ext'))
    // Strict FIFO order: seed, then the save, then the external content.
    expect(w.ledgerWrites.map(([, text]) => text)).toEqual(['v1', 'v2-human', 'v-ext'])
  })
})

describe('createSyncEngine — extreme contention: write→delete→write collapse within one notification window', () => {
  it('a path that ended at new content after intermediate states records ONLY the final content, never an rm', async () => {
    const w = makeStatefulWorld({ 'f.js': 'v1' })
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const engine = createSyncEngine(w.client, w.port, { applyToEditor })
    await engine.populateLedger()
    engine.start()

    // Disk raced through v1 -> (deleted) -> v-final before the (debounced/
    // polled) notification is processed; the engine reads AT APPLY TIME and
    // must see only the final state.
    w.delDisk('f.js')
    w.setDisk('f.js', 'v-final')
    w.watch.emitBatch(['f.js'])

    await vi.waitFor(() => expect(w.ledger.get('f.js')).toBe('v-final'))
    expect(w.client.rm).not.toHaveBeenCalled()
    expect(applyToEditor).toHaveBeenCalledTimes(1)
  })

  it('a path that ended deleted after intermediate rewrites performs exactly one rm and one editor null-apply', async () => {
    const w = makeStatefulWorld({ 'f.js': 'v1' })
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const engine = createSyncEngine(w.client, w.port, { applyToEditor })
    await engine.populateLedger()
    engine.start()

    w.setDisk('f.js', 'v2') // intermediate state nobody will ever observe
    w.delDisk('f.js')
    w.watch.emitBatch(['f.js'])

    await vi.waitFor(() => expect(w.client.rm).toHaveBeenCalledTimes(1))
    expect(w.client.rm).toHaveBeenCalledWith('f.js', { actor: 'human' })
    expect(applyToEditor).toHaveBeenCalledTimes(1)
    expect(applyToEditor).toHaveBeenCalledWith('f.js', null)
    expect(w.ledger.has('f.js')).toBe(false)
  })

  it('a duplicated path within one batch commits exactly once (second occurrence absorbs as its own echo)', async () => {
    const w = makeStatefulWorld()
    const applyToEditor = vi.fn().mockResolvedValue(undefined)
    const engine = createSyncEngine(w.client, w.port, { applyToEditor })
    await engine.populateLedger()
    engine.start()

    w.setDisk('f.js', 'v1')
    w.watch.emitBatch(['f.js', 'f.js', 'f.js'])

    await vi.waitFor(() => expect(w.ledger.get('f.js')).toBe('v1'))
    await new Promise((r) => setTimeout(r, 10))
    expect(w.ledgerWrites.filter(([rel]) => rel === 'f.js')).toHaveLength(1)
    expect(applyToEditor).toHaveBeenCalledTimes(1)
  })
})

describe('createSyncEngine — bulk inbound batches', () => {
  it('a 300-path batch lands every file exactly once, and its full echo re-delivery commits nothing', async () => {
    const w = makeStatefulWorld()
    for (let i = 0; i < 300; i++) w.setDisk(`bulk/f${i}.js`, `content-${i}`)
    const engine = createSyncEngine(w.client, w.port)
    await engine.populateLedger()
    // populateLedger already seeded all 300 — reset the write log so the
    // batch-driven commits below are counted from zero. (A REAL bulk batch
    // arrives post-seed, e.g. `git checkout` switching branches.)
    for (let i = 0; i < 300; i++) w.setDisk(`bulk/f${i}.js`, `checkout-${i}`)
    engine.start()
    const paths = [...w.disk.keys()]
    ;(w.client.write as ReturnType<typeof vi.fn>).mockClear()
    w.ledgerWrites.length = 0

    w.watch.emitBatch(paths)
    await vi.waitFor(() => expect(w.ledger.get('bulk/f299.js')).toBe('checkout-299'), { timeout: 10_000 })

    expect(w.ledgerWrites).toHaveLength(300)
    expect(new Set(w.ledgerWrites.map(([rel]) => rel)).size).toBe(300)

    // Full echo re-delivery (the watcher reporting our own already-recorded
    // tree, e.g. after a debounce hiccup): zero additional commits. The
    // negative assertion waits for REAL quiescence (two consecutive samples
    // with no new ledger writes) instead of a fixed sleep, so a slower
    // implementation cannot slip a late duplicate past the check.
    w.ledgerWrites.length = 0
    w.watch.emitBatch(paths)
    let lastCount = -1
    await vi.waitFor(
      () => {
        if (w.ledgerWrites.length !== lastCount) {
          lastCount = w.ledgerWrites.length
          throw new Error('ledger still settling')
        }
      },
      { timeout: 10_000, interval: 100 },
    )
    expect(w.ledgerWrites).toHaveLength(0)
  })
})
