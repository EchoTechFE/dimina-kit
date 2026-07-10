/**
 * Unit tests for the watch-batch expander's stat-diff contract, against a
 * fake stat-capable readdir. The full black-box behavior (through a real
 * TruthPort assembly) stays covered by dimina-kit workbench's
 * wal-audit-disk-stat-expansion.test.ts — these pin the module's own
 * algorithmic promises at the fs-core boundary.
 */
import { describe, expect, it } from 'vitest'
import { createWatchExpander } from './watch-expander.js'
import type { WatchExpanderEntry } from './watch-expander.js'

/** In-memory tree: rel -> {size, mtimeMs}. Directories are implied by their
 * children's paths, same as a real filesystem listing would show them. */
function makeDisk(files: Record<string, { size: number; mtimeMs: number }>) {
  const readdir = async (rel: string): Promise<WatchExpanderEntry[]> => {
    const prefix = rel === '.' || rel === '' ? '' : `${rel}/`
    const names = new Map<string, WatchExpanderEntry>()
    let matchedScope = prefix === ''
    for (const [p, stat] of Object.entries(files)) {
      if (!p.startsWith(prefix)) continue
      matchedScope = true
      const rest = p.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) names.set(rest, [rest, 1, stat.size, stat.mtimeMs])
      else names.set(rest.slice(0, slash), [rest.slice(0, slash), 2])
    }
    // A path that is neither a file nor an ancestor of one does not exist —
    // and listing a FILE path is an error too, like a real readdir(file).
    if (!matchedScope || rel in files) throw new Error(`ENOTDIR/ENOENT: ${rel}`)
    return [...names.values()]
  }
  return { files, readdir }
}

describe('createWatchExpander', () => {
  it('reports only the stat-changed file for a coalesced directory event (after warm-up)', async () => {
    const disk = makeDisk({
      'src/a.txt': { size: 3, mtimeMs: 100 },
      'src/b.txt': { size: 3, mtimeMs: 100 },
      'src/c.txt': { size: 3, mtimeMs: 100 },
    })
    const ex = createWatchExpander(disk.readdir)
    await ex.warmFromDisk()
    disk.files['src/b.txt'] = { size: 4, mtimeMs: 200 }
    const out = await ex.expandWatchBatch(['src'], ['src/a.txt', 'src/b.txt', 'src/c.txt'])
    expect(out).toEqual(['src/b.txt'])
  })

  it('recovers a coalesced deletion: ledger paths missing from the listed scope are reported', async () => {
    const disk = makeDisk({ 'src/a.txt': { size: 3, mtimeMs: 100 } })
    const ex = createWatchExpander(disk.readdir)
    await ex.warmFromDisk()
    // rm -rf took b.txt and c.txt; the watcher only named the directory.
    const out = await ex.expandWatchBatch(['src'], ['src/a.txt', 'src/b.txt', 'src/c.txt'])
    expect(out.sort()).toEqual(['src/b.txt', 'src/c.txt'])
  })

  it("expands the '.' overflow rescan against the whole tree + whole ledger", async () => {
    const disk = makeDisk({ 'kept.txt': { size: 1, mtimeMs: 1 }, 'new.txt': { size: 1, mtimeMs: 1 } })
    const ex = createWatchExpander(disk.readdir)
    // warm only knows kept.txt
    delete disk.files['new.txt']
    await ex.warmFromDisk()
    disk.files['new.txt'] = { size: 1, mtimeMs: 1 }
    const out = await ex.expandWatchBatch(['.'], ['kept.txt', 'gone.txt'])
    expect(out.sort()).toEqual(['gone.txt', 'new.txt'])
  })

  it('always reports a point-named plain file (content can change without a stat move)', async () => {
    const disk = makeDisk({ 'a.txt': { size: 3, mtimeMs: 100 } })
    const ex = createWatchExpander(disk.readdir)
    await ex.warmFromDisk()
    // stat unchanged — the file itself must still be reported.
    const out = await ex.expandWatchBatch(['a.txt'], ['a.txt'])
    expect(out).toEqual(['a.txt'])
  })

  it('excludes a point-named live directory UNLESS the ledger still records that exact path', async () => {
    const disk = makeDisk({ 'src/a.txt': { size: 3, mtimeMs: 100 } })
    const ex = createWatchExpander(disk.readdir)
    await ex.warmFromDisk()
    expect(await ex.expandWatchBatch(['src'], ['src/a.txt'])).toEqual([])
    // Same-named file→directory replacement: a stale ledger FILE record at
    // 'src' must be reported so the engine's read can retire it.
    expect(await ex.expandWatchBatch(['src'], ['src', 'src/a.txt'])).toEqual(['src'])
  })

  it('resetIndex() forgets the session index: every disk file reports again', async () => {
    const disk = makeDisk({ 'src/a.txt': { size: 3, mtimeMs: 100 } })
    const ex = createWatchExpander(disk.readdir)
    await ex.warmFromDisk()
    expect(await ex.expandWatchBatch(['src'], ['src/a.txt'])).toEqual([])
    ex.resetIndex()
    expect(await ex.expandWatchBatch(['src'], ['src/a.txt'])).toEqual(['src/a.txt'])
  })
})
