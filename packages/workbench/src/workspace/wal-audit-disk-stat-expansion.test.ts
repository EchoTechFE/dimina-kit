/**
 * Guards for wal-audit.ts's disk-watch batch expansion: a raw fs-watcher
 * event only names a handful of paths (a changed file, a touched directory,
 * or a few of a bulk-deleted tree's children — real FSEvents coalescing).
 * The expansion step is supposed to turn that into "paths whose disk stat
 * actually changed" via a cheap `bridge.readdir` size/mtimeMs listing,
 * BEFORE any path is handed to the sync engine (which does the expensive
 * `bridge.read` content fetch). These three tests exercise that contract as
 * a black box, purely through `walAuditSource`'s public `watchEvents` /
 * `bridge` / `createClient` test seams — no internals of
 * expandWatchPath/listDiskNames/expandWatchBatch are read or assumed beyond
 * what wal-audit.ts's exported types document:
 *
 *  1. read-amplification guard — changing 1 file inside a 200-file
 *     directory must cause exactly 1 `bridge.read` call on the incremental
 *     batch, not 200.
 *  2. merged-delete fidelity — a bulk external delete of 200 files,
 *     reported by the watcher as only 3 of the deleted paths, must still
 *     reconcile the ledger down to zero surviving entries for that subtree.
 *  3. merged-modify fidelity — a single changed file inside a 20-file
 *     directory, reported only via a directory-level watch batch, must
 *     cause `bridge.read` to be called for that one file and no sibling.
 *
 * Against the CURRENT (unfixed) implementation, which re-reads every path
 * the expansion can reach near a watch event, (1) and (3) are expected to
 * fail; the run output is recorded in the task report, not asserted here.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSource } from './types.js'
import type { WalAuditBridge, WalAuditClientLike } from './wal-audit.js'
import { walAuditSource } from './wal-audit.js'

type FileServiceArg = Parameters<WorkspaceSource['populate']>[0]

const fakeFileService = {} as unknown as FileServiceArg

// wal-audit.ts's `WalAuditBridge` readdir is being widened from
// `Array<[string, number]>` to also carry size/mtimeMs for FILE entries
// (directory entries stay the 2-element `[name, 2]` shape) — see the task
// brief. The current type doesn't know about this yet, so these doubles are
// built against the NEW 4-tuple shape and cast at the `bridge:` call site;
// today's code only ever destructures `[name, type]` off each entry, so the
// widened doubles remain valid once the real readdir signature lands.
type FsEntry = [name: string, type: number, size?: number, mtimeMs?: number]

/** An in-memory "virtual disk": full POSIX-relative paths -> content+mtime.
 * Directories are implicit (derived from path prefixes), matching the real
 * `/__fs` bridge's semantics that `readdir('')`/`readdir('.')` lists the
 * project root. */
class VirtualDisk {
  private files = new Map<string, { content: string; mtimeMs: number }>()
  private clock = 1_000_000

  private nextMtime(): number {
    this.clock += 1000
    return this.clock
  }

  set(rel: string, content: string, mtimeMs?: number): void {
    this.files.set(rel, { content, mtimeMs: mtimeMs ?? this.nextMtime() })
  }

  delete(rel: string): void {
    this.files.delete(rel)
  }

  readdir(rel: string): FsEntry[] {
    const prefix = rel === '' || rel === '.' || rel === '/' ? '' : rel.replace(/^\/+|\/+$/g, '')
    const dirs = new Set<string>()
    const entries: FsEntry[] = []
    for (const [path, { content, mtimeMs }] of this.files) {
      if (prefix && !(path === prefix || path.startsWith(`${prefix}/`))) continue
      const tail = prefix ? path.slice(prefix.length + 1) : path
      if (!tail) continue
      const slash = tail.indexOf('/')
      if (slash === -1) {
        const size = new TextEncoder().encode(content).length
        entries.push([tail, 1, size, mtimeMs])
      } else {
        const dirName = tail.slice(0, slash)
        if (!dirs.has(dirName)) {
          dirs.add(dirName)
          entries.push([dirName, 2])
        }
      }
    }
    return entries
  }

  read(rel: string): Uint8Array {
    const f = this.files.get(rel)
    if (!f) throw Object.assign(new Error(`not found: ${rel}`), { status: 404 })
    return new TextEncoder().encode(f.content)
  }
}

function makeVirtualBridge(disk: VirtualDisk) {
  return {
    readdir: vi.fn(async (_baseUrl: string, rel: string) => disk.readdir(rel)),
    read: vi.fn(async (_baseUrl: string, rel: string) => disk.read(rel)),
    write: vi.fn(async (_baseUrl: string, rel: string, content: Uint8Array) => {
      disk.set(rel, new TextDecoder().decode(content))
    }),
    delete: vi.fn(async (_baseUrl: string, rel: string) => {
      disk.delete(rel)
    }),
  }
}

/** A fake `WalAuditClientLike` backed by an in-memory ledger map — every
 * method is a `vi.fn()` so call counts/args are assertable, per wal-audit.test.ts's style. */
function makeLedgerClient(ledger: Map<string, string>): WalAuditClientLike {
  return {
    write: vi.fn(async (path: string, content: string) => {
      ledger.set(path, content)
    }),
    rm: vi.fn(async (path: string) => {
      ledger.delete(path)
    }),
    restore: vi.fn().mockResolvedValue(undefined),
    turnBegin: vi.fn().mockResolvedValue(undefined),
    turnEnd: vi.fn().mockResolvedValue(undefined),
    diff: vi.fn().mockResolvedValue({ changes: [] }),
    read: vi.fn(async (path: string) => {
      if (!ledger.has(path)) throw Object.assign(new Error('nf'), { code: 'not-found' })
      return { content: ledger.get(path)! }
    }),
    ls: vi.fn(async () => ({ paths: [...ledger.keys()] })),
    status: vi.fn().mockResolvedValue({ mode: 'rw', walGen: 0, epoch: 0 }),
    destroy: vi.fn(),
  }
}

function makeBase(): WorkspaceSource {
  return {
    folderUri: 'file:///workspace',
    populate: vi.fn().mockResolvedValue(0),
    onSave: vi.fn().mockResolvedValue(undefined),
  }
}

/** Wires a `walAuditSource` against the virtual disk/ledger doubles above,
 * capturing the raw `onBatch` callback handed to our injected `watchEvents`
 * seam so a test can simulate a raw fs-watcher event with `fireBatch(paths)`. */
function makeHarness() {
  const disk = new VirtualDisk()
  const ledger = new Map<string, string>()
  const bridge = makeVirtualBridge(disk)
  const client = makeLedgerClient(ledger)
  let capturedOnBatch: ((paths: string[]) => void) | undefined
  const watchEvents = vi.fn((onBatch: (paths: string[]) => void, _onDead: () => void) => {
    capturedOnBatch = onBatch
    return () => {}
  })

  const source = walAuditSource(makeBase(), {
    fsBaseUrl: 'https://fs.example/',
    createClient: vi.fn().mockResolvedValue(client),
    bridge: bridge as unknown as WalAuditBridge,
    watchEvents,
  })

  return {
    disk,
    ledger,
    bridge,
    client,
    source,
    fireBatch(paths: string[]) {
      if (!capturedOnBatch) {
        throw new Error('watchEvents onBatch not captured yet — call fireBatch after populate()')
      }
      capturedOnBatch(paths)
    },
  }
}

describe('wal-audit disk-watch expansion — read-amplification guard', () => {
  it('changing 1 file in a 200-file directory triggers exactly 1 bridge.read on the incremental batch', async () => {
    const { disk, ledger, bridge, source, fireBatch } = makeHarness()
    for (let i = 0; i < 200; i++) disk.set(`dir/f${i}.txt`, `content-${i}`)

    await source.populate(fakeFileService)
    expect(ledger.size).toBe(200) // sanity: populate seeded the ledger from disk

    // Warm-up: populate() seeds the ledger via a plain disk walk, not via the
    // watch-batch expansion path, so the module's per-file "last known stat"
    // cache is still cold. A fresh/untouched path is always reported on its
    // first sighting (by design, not a bug) — so this directory-level batch
    // must run and settle once before incremental behavior is measured.
    fireBatch(['dir'])
    await vi.waitFor(
      () => {
        expect(bridge.readdir).toHaveBeenCalled()
      },
      { timeout: 8000, interval: 20 },
    )
    // Let any trailing microtask/ledger-turn-queue work from the warm-up drain.
    await new Promise((resolve) => setTimeout(resolve, 150))

    bridge.read.mockClear()

    const newContent = 'content-5-CHANGED'
    disk.set('dir/f5.txt', newContent)
    fireBatch(['dir/f5.txt'])

    await vi.waitFor(
      () => {
        expect(bridge.read).toHaveBeenCalledTimes(1)
      },
      { timeout: 8000, interval: 20 },
    )
    // Give any extra (incorrect) reads a chance to show up before the final assertion.
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(bridge.read).toHaveBeenCalledTimes(1)
    expect(bridge.read).toHaveBeenCalledWith(expect.any(String), 'dir/f5.txt')
    expect(ledger.get('dir/f5.txt')).toBe(newContent)
  }, 20000) // outer timeout raised above vitest's 5000ms default: this test runs two generous (8000ms) vi.waitFor windows plus settle buffers
})

describe('wal-audit disk-watch expansion — merged-delete fidelity', () => {
  it('reconciles all 200 deleted files even though the watcher only names 3 of them', async () => {
    const { disk, ledger, client, source, fireBatch } = makeHarness()
    for (let i = 0; i < 200; i++) disk.set(`bulk/f${i}.txt`, `content-${i}`)

    await source.populate(fakeFileService)
    expect(ledger.size).toBe(200)

    // Simulate an external `rm -rf bulk/` that already completed on disk —
    // mutate the virtual disk map directly, not through bridge.delete.
    for (let i = 0; i < 200; i++) disk.delete(`bulk/f${i}.txt`)
    fireBatch(['bulk/f0.txt', 'bulk/f17.txt', 'bulk/f88.txt'])

    await vi.waitFor(
      () => {
        const remaining = [...ledger.keys()].filter((p) => p.startsWith('bulk/'))
        expect(remaining).toHaveLength(0)
      },
      { timeout: 10000, interval: 20 },
    )

    // bulk/f199.txt was never named in the batch — it must still have been
    // reconciled as deleted, not just the 3 explicitly-named paths.
    expect(ledger.has('bulk/f199.txt')).toBe(false)
    const rmPaths = (client.rm as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string)
    expect(rmPaths).toContain('bulk/f199.txt')
    expect(rmPaths.filter((p) => p.startsWith('bulk/'))).toHaveLength(200)
  }, 20000) // outer timeout raised above vitest's 5000ms default: the vi.waitFor window below is 10000ms
})

describe('wal-audit disk-watch expansion — merged-modify fidelity', () => {
  it('a directory-level watch event only re-reads the one file that actually changed', async () => {
    const { disk, ledger, bridge, source, fireBatch } = makeHarness()
    for (let i = 0; i < 20; i++) disk.set(`moddir/g${i}.txt`, `content-${i}`)

    await source.populate(fakeFileService)
    expect(ledger.size).toBe(20)

    bridge.read.mockClear()

    const newContent = 'content-7-CHANGED'
    disk.set('moddir/g7.txt', newContent)
    fireBatch(['moddir'])

    await vi.waitFor(
      () => {
        expect(ledger.get('moddir/g7.txt')).toBe(newContent)
      },
      { timeout: 8000, interval: 20 },
    )
    // Let any trailing sibling reads (from an unfixed implementation) show up
    // before asserting exactly which paths were read.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const readRels = bridge.read.mock.calls.map((call) => call[1] as string)
    expect(readRels).toContain('moddir/g7.txt')
    // No unchanged sibling out of the other 19 files in moddir/ may appear —
    // dedup of moddir/g7.txt itself is not required, just no OTHER path.
    expect(new Set(readRels)).toEqual(new Set(['moddir/g7.txt']))
  }, 20000) // outer timeout raised above vitest's 5000ms default: the vi.waitFor window below is 8000ms
})
