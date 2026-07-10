/**
 * Watch-batch expansion — an OPTIONAL port-side helper for assembling a
 * `TruthPort.changes` adapter (see truth-port.ts: turning a watcher's
 * coalesced/lossy events into the actual set of paths worth re-examining is
 * the PORT's responsibility; sync-engine.ts's `handleBatch` trusts the
 * expanded batch as-is and does no expansion of its own). It turns raw
 * `fs.watch`-style paths (which may be coalesced ancestor-DIRECTORY events,
 * an overflow `'.'` full-tree rescan, or the name of a file that no longer
 * exists) into the set of paths the sync engine should actually re-examine.
 * The only dependency is a stat-capable `readdir` (one listing call, no
 * content bytes) — see {@link WatchExpanderReaddir}.
 *
 * Why events are only a HINT, not the truth: FSEvents-style recursive
 * watchers COALESCE a write burst into ancestor-DIRECTORY events (and an
 * overflow surfaces as a null filename, reported as `'.'`) — observed: a
 * 200-file external burst delivered only 132 per-file events, the rest
 * arriving as their parent directory. So a watched path is not necessarily a
 * file, and "nothing was reported for path X" does not mean X is unchanged.
 *
 * How stat-level truth-checking works (the git-index/rsync pattern): for
 * every watch path, this module lists the TRUTH SOURCE's current
 * (size, mtimeMs) for every file in that path's scope (itself + its parent
 * directory — the same scope FSEvents coalescing collapses onto) and diffs it
 * against a session-scoped index of what it last saw for each file:
 *   - a ledger path inside the scanned scope that is now missing from the
 *     disk listing is reported as a deletion (this is what recovers a
 *     coalesced `rm -rf`, which a real watcher may name only a few of the
 *     removed children for, or none) — unconditional, since a deletion has
 *     no "stat" to compare;
 *   - a disk file whose stat is NEW or DIFFERENT from the index is reported,
 *     and the index is updated to match;
 *   - a disk file whose stat is UNCHANGED is a stat-confirmed survivor and is
 *     never reported. This is the whole point: an N-file directory with one
 *     real change no longer costs the engine N content reads (readdir stats
 *     are cheap — one listing round trip per directory level, no bytes —
 *     while the engine's `handleInboundPath` does a full `port.read` per
 *     reported path);
 *   - the event path `p` ITSELF is additionally, unconditionally reported
 *     UNLESS it is currently a confirmed live, listable directory with no
 *     ledger record sitting at that exact path. Content can change without a
 *     stat move (same-size in-place edit inside one filesystem timestamp
 *     tick — the classic "racy git" case), and this module never reads file
 *     CONTENT to judge that — only the engine's own read+compare can, which
 *     is why a plain file / deleted path / transient probe failure always
 *     gets reported. A CONFIRMED live directory has no content of its own to
 *     mis-judge that way, so reporting it would normally just cost a wasted
 *     `port.read` (404 → EISDIR) — EXCEPT when the ledger still holds a
 *     record AT THAT EXACT PATH (a stale FILE record from before the path
 *     was replaced by a directory — see "Same-named file→directory
 *     replacement" below): that record needs the same EISDIR→404 retirement
 *     path, and for a ROOT-LEVEL replaced path (no parent directory of its
 *     own) the ledger-deletion sweep below cannot reach it by prefix at all,
 *     so this is the only path that retires it.
 * Over-reporting is always safe (the engine content-compares every reported
 * path, so a false positive is a no-op); under-reporting is what loses data,
 * which is why the ledger-deletion sweep and the point-named path (per the
 * exception above) are unconditional rather than stat-gated.
 *
 * Same-named file→directory replacement: EVERY scope gets the readdir probe,
 * even when the path is a ledger-known FILE — a file can have been replaced
 * by a same-named directory, and skipping the probe for "known files" would
 * silently drop that directory's whole subtree (the watcher only names the
 * parent). The stale ledger FILE record retires via whichever of two paths
 * applies: the point-named-path exception above (when the watcher names the
 * replaced path directly — the only option when it has no parent directory
 * of its own to register a scope prefix), or the ledger-deletion sweep's
 * PARENT-scope prefix (when the watcher instead names a sibling or the
 * parent directory — the record no longer matches the replaced path's own
 * now-a-directory prefix, only the parent's). Either way the engine's
 * `port.read` gets EISDIR (mapped to a not-found by e.g. the devtools
 * bridge), which its not-found discipline treats as a deletion.
 *
 * Index lifecycle: `resetIndex()` clears the session-scoped stat index —
 * call it whenever the ledger itself is reseeded (e.g. dimina-kit
 * wal-audit.ts's `initLedger`), so a stale index can never survive a project
 * switch or ledger rebuild. `warmFromDisk()` then seeds it directly from the
 * CURRENT disk tree right after the reseed (called once the ledger walk
 * itself has completed) — without this, the first watch batch after every
 * project open would see an all-cold index and re-report every file it
 * touches, defeating the point of stat-diffing for exactly the common case
 * (a directory-level event shortly after open). A path this module has never
 * seen at all (warm-up included) is always reported on its first sighting —
 * nothing is missed by a partial/failed warm-up, it just costs that one
 * file's content read instead of being skipped.
 */

/** One truth-source directory entry: `[name, type, size?, mtimeMs?]` with
 * `type === 2` meaning directory. `size`/`mtimeMs` are expected for FILE
 * entries — a stat-less entry safely degrades to "always report" (see
 * {@link toDiskStat}). */
export type WatchExpanderEntry = [name: string, type: number, size?: number, mtimeMs?: number]

/** The single dependency: list one directory (project-relative path, `'.'`
 * or `''` = the root) of the truth source, with per-file stats. */
export type WatchExpanderReaddir = (rel: string) => Promise<WatchExpanderEntry[]>

interface DiskStat {
  size: number
  mtimeMs: number
}

export interface WatchExpander {
  /** Expand one raw watch batch into the paths worth re-examining, given the
   * ledger's current path list (used to detect coalesced deletions). */
  expandWatchBatch(paths: string[], ledgerPaths: string[]): Promise<string[]>
  /** Clear the session-scoped stat index — call on every ledger reseed. */
  resetIndex(): void
  /** Seed the stat index directly from the current disk tree (no reporting)
   * — call once right after the ledger reseed completes; see this module's
   * doc "Index lifecycle". A (partial or total) failure just leaves the
   * index short of some paths, which safely degrades to "always report on
   * first sighting" for those — never a correctness issue. */
  warmFromDisk(): Promise<void>
}

/** A stat-less disk entry (a readdir/stat race on the truth-source side)
 * never matches a cached stat: `NaN !== NaN` unconditionally, so a racy
 * entry is always reported rather than risking a false "unchanged" skip. */
function toDiskStat(size: number | undefined, mtimeMs: number | undefined): DiskStat {
  return { size: size ?? Number.NaN, mtimeMs: mtimeMs ?? Number.NaN }
}

/** `rel`'s scope prefixes for the ledger-deletion sweep: itself-as-a-directory
 * and its parent directory — the same two listings {@link createWatchExpander}'s
 * `listDiskStats` probes. `''` (the whole-ledger prefix) only ever arises from
 * the `'.'` overflow rescan, handled by the caller before this is reached. */
function scopePrefixes(rel: string): { prefixes: Set<string>; parentRel: string; slash: number } {
  const slash = rel.lastIndexOf('/')
  const parentRel = slash >= 0 ? rel.slice(0, slash) : ''
  const prefixes = new Set<string>([rel ? `${rel}/` : ''])
  if (slash >= 0) prefixes.add(parentRel ? `${parentRel}/` : '')
  return { prefixes, parentRel, slash }
}

/** `true` when `q` falls under one of `prefixes` (`''` matches everything —
 * the `'.'` overflow case). */
function inScope(q: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) {
    if (prefix === '' || q.startsWith(prefix)) return true
  }
  return false
}

export function createWatchExpander(readdir: WatchExpanderReaddir): WatchExpander {
  /** Session-scoped: `rel -> last stat this module reported for it`. Cleared
   * by `resetIndex()`, seeded by `warmFromDisk()`; see this module's doc
   * "Index lifecycle". */
  let statIndex = new Map<string, DiskStat>()

  /** List every FILE's current (size, mtimeMs) under `startRel`, recursively
   * — NO content reads (a content walk would turn each expansion pass back
   * into a content-read storm). */
  async function listDiskStats(startRel: string, out: Map<string, DiskStat>): Promise<void> {
    async function walk(rel: string): Promise<void> {
      const entries = await readdir(rel || '.')
      for (const [name, type, size, mtimeMs] of entries) {
        const childRel = rel ? `${rel}/${name}` : name
        if (type === 2) await walk(childRel)
        else out.set(childRel, toDiskStat(size, mtimeMs))
      }
    }
    await walk(startRel)
  }

  /** One swallowed stat-listing probe. Returns whether `rel` is CURRENTLY a
   * live, listable directory (a plain file, a deleted path, or any other
   * probe failure all report `false`) — the caller uses this to decide
   * whether the point-named path itself needs an unconditional report (see
   * this module's doc). Failure otherwise changes nothing: the caller's own
   * ledger-deletion sweep still covers a deleted/replaced path, and a tree
   * mutating mid-walk just means the stats collected so far are what count. */
  async function probeDiskStats(rel: string, out: Map<string, DiskStat>): Promise<boolean> {
    try {
      await listDiskStats(rel, out)
      return true
    } catch {
      return false
    }
  }

  /** Expand ONE watch path into `out` — see this module's doc for the full
   * algorithm. `p === '.'` is the overflow full-tree rescan: scope is the
   * whole tree (`rel = ''`, no parent probe, ledger prefix `''` matches
   * every path). `ledgerPathSet` is `ledgerPaths` as a `Set` for the O(1)
   * exact-path membership check the point-named-path exception needs. */
  async function expandWatchPath(
    p: string,
    ledgerPaths: string[],
    ledgerPathSet: ReadonlySet<string>,
    out: Set<string>,
  ): Promise<void> {
    const rel = p === '.' ? '' : p
    const diskStats = new Map<string, DiskStat>()
    const isLiveDirectory = await probeDiskStats(rel, diskStats)
    const { prefixes, parentRel, slash } = scopePrefixes(rel)
    if (p !== '.' && slash >= 0) await probeDiskStats(parentRel, diskStats)
    // See this module's doc for why a confirmed live directory is excluded
    // UNLESS the ledger still has a stale record at that exact path.
    if (p !== '.' && (!isLiveDirectory || ledgerPathSet.has(p))) out.add(p)

    // Ledger paths in scope but missing from the disk listing — coalesced
    // deletions (see this module's doc).
    for (const q of ledgerPaths) {
      if (!inScope(q, prefixes)) continue
      if (!diskStats.has(q)) {
        out.add(q)
        statIndex.delete(q)
      }
    }

    // Disk files in scope: report new/changed, skip stat-confirmed survivors.
    for (const [q, stat] of diskStats) {
      const known = statIndex.get(q)
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue
      out.add(q)
      statIndex.set(q, stat)
    }
  }

  return {
    async expandWatchBatch(paths, ledgerPaths) {
      const out = new Set<string>()
      const ledgerPathSet = new Set(ledgerPaths)
      for (const p of paths) await expandWatchPath(p, ledgerPaths, ledgerPathSet, out)
      return [...out]
    },
    resetIndex() {
      statIndex = new Map<string, DiskStat>()
    },
    async warmFromDisk() {
      const warm = new Map<string, DiskStat>()
      await probeDiskStats('', warm)
      statIndex = warm
    },
  }
}
