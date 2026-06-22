/**
 * Sandbox hardening tests for the project-fs IPC handlers.
 *
 * The renderer-side Monaco editor talks to `project:fs:*` to read/write files
 * inside the *currently open project*. The sandbox must keep every operation
 * inside the live project root. The headline hole this suite pins down:
 *
 *   - `enforceWithinProjectRoot` only ran a string-prefix check on
 *     `path.resolve(abs)` and never resolved symlinks. A symlink *inside* the
 *     root pointing *outside* it (`proj/link.txt -> ../secret.txt`) passed the
 *     check, so `fs.readFile`/`fs.writeFile` happily followed it out of the
 *     sandbox. The "symlink escape" tests below are RED against the original
 *     implementation and GREEN once both sides go through `fs.realpath`.
 *
 * All fixtures use a real temp dir (os.tmpdir + node:fs) so the symlink
 * behaviour is exercised against the actual filesystem, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import nodeFs, { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── TOCTOU seam hooks ────────────────────────────────────────────────────────
// Vitest cannot `vi.spyOn` a `node:fs/promises` ESM namespace import ("Module
// namespace is not configurable in ESM"). So instead we MOCK the module with a
// factory that delegates to the real implementation by default but consults
// per-test override hooks for the two seams the TOCTOU tests need to intercept
// (`open` for the open-time race, `realpath` for the post-open re-verify
// fallback). Tests set `__fsHooks.open` / `__fsHooks.realpath` to inject the
// race, then clear them in afterEach. The impl reads these via its own
// `import fs from 'node:fs/promises'`, so the override is observed at call time.
const __fsHooks: {
  open?: (...args: unknown[]) => unknown
  realpath?: (...args: unknown[]) => unknown
} = {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const wrapped: Record<string, unknown> = { ...actual }
  wrapped.open = (...args: unknown[]) =>
    (__fsHooks.open ?? (actual.open as (...a: unknown[]) => unknown))(...args)
  wrapped.realpath = (...args: unknown[]) =>
    (__fsHooks.realpath ?? (actual.realpath as (...a: unknown[]) => unknown))(...args)
  // Expose the REAL (unwrapped) open/realpath so a race hook can delegate to
  // them without re-entering the wrapper (delegating to `wrapped.*` would
  // consult the hook again → infinite recursion / corrupted call counts).
  wrapped.__actualOpen = actual.open
  wrapped.__actualRealpath = actual.realpath
  // The impl does `import fs from 'node:fs/promises'`; expose the same object
  // as the default export so `fs.open` / `fs.realpath` hit the wrappers.
  return { ...wrapped, default: wrapped }
})

// `project-fs.ts` pulls in `IpcRegistry`, which does a module-level
// `import { ipcMain } from 'electron'`. CI runs vitest under plain Node with no
// Electron binary installed, so loading the real module throws "Electron failed
// to install correctly". These tests only exercise the pure `__testing` path
// helpers (never ipcMain), so stub electron — vitest hoists this above the
// static import below.
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

import { enforceWithinProjectRoot, __testing } from './project-fs.js'

const { readFile, writeFile, listFiles } = __testing

/** Distinct temp roots per test so symlink fixtures never collide. */
let workdir: string
/** The "project root" handed to the handlers (realpath'd by the caller). */
let projectRoot: string
/** A directory living *outside* the project root — the escape target. */
let outside: string

beforeEach(async () => {
  // realpath the base so macOS /var -> /private/var aliasing doesn't make the
  // containment check spuriously fail on legitimate paths.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pfs-')))
  workdir = base
  projectRoot = path.join(base, 'proj')
  outside = path.join(base, 'outside')
  await fs.mkdir(projectRoot, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
})

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

/** Join under the project root the same way the renderer does (POSIX joins). */
function inRoot(...segs: string[]): string {
  return path.join(projectRoot, ...segs)
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown, `expected a throw with code ${code}`).toBeInstanceOf(Error)
  expect((thrown as NodeJS.ErrnoException).code).toBe(code)
}

async function expectRejectCode(p: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await p
  } catch (err) {
    thrown = err
  }
  expect(thrown, `expected a rejection with code ${code}`).toBeInstanceOf(Error)
  expect((thrown as NodeJS.ErrnoException).code).toBe(code)
}

describe('enforceWithinProjectRoot — string-level escapes', () => {
  it('rejects relative `..` traversal that climbs out of the root', () => {
    expectCode(() => enforceWithinProjectRoot(inRoot('..', 'outside', 'f.txt'), projectRoot), 'EACCES')
  })

  it('rejects an absolute path that points outside the root', () => {
    expectCode(() => enforceWithinProjectRoot(path.join(outside, 'f.txt'), projectRoot), 'EACCES')
  })

  it('rejects a sibling-prefix path (/x/proj-evil vs root /x/proj)', () => {
    const evil = `${projectRoot}-evil`
    expectCode(() => enforceWithinProjectRoot(path.join(evil, 'f.txt'), projectRoot), 'EACCES')
  })

  it('throws ENOACTIVE when no project is open (empty root)', () => {
    expectCode(() => enforceWithinProjectRoot(inRoot('f.txt'), ''), 'ENOACTIVE')
  })

  it('rejects a NUL byte in the path', () => {
    expectCode(() => enforceWithinProjectRoot(inRoot('a\0b.txt'), projectRoot), 'EINVAL')
  })
})

describe('readFile / writeFile / listFiles — legitimate access', () => {
  it('reads a normal file inside the root', async () => {
    await fs.writeFile(inRoot('hello.txt'), 'hi', 'utf8')
    await expect(readFile(projectRoot, inRoot('hello.txt'))).resolves.toBe('hi')
  })

  it('writes a normal file inside the root (creating parent dirs)', async () => {
    await writeFile(projectRoot, inRoot('nested', 'deep', 'out.txt'), 'data')
    await expect(fs.readFile(inRoot('nested', 'deep', 'out.txt'), 'utf8')).resolves.toBe('data')
  })

  it('lists files inside the root', async () => {
    await fs.writeFile(inRoot('a.txt'), '1', 'utf8')
    await fs.mkdir(inRoot('sub'), { recursive: true })
    await fs.writeFile(inRoot('sub', 'b.txt'), '2', 'utf8')
    const listed = await listFiles(projectRoot, projectRoot)
    expect(listed.sort()).toEqual(['a.txt', 'sub/b.txt'])
  })

  it('still allows a legit subfile when the root itself is reached via a symlink', async () => {
    // The *root* is a symlink to a real directory holding a legit file.
    const realDir = path.join(workdir, 'real-project')
    await fs.mkdir(realDir, { recursive: true })
    await fs.writeFile(path.join(realDir, 'ok.txt'), 'good', 'utf8')
    const linkedRoot = path.join(workdir, 'linked-project')
    await fs.symlink(realDir, linkedRoot, 'dir')

    // Caller passes the symlinked root + a child path through that symlink.
    await expect(readFile(linkedRoot, path.join(linkedRoot, 'ok.txt'))).resolves.toBe('good')
    await writeFile(linkedRoot, path.join(linkedRoot, 'ok2.txt'), 'good2')
    await expect(fs.readFile(path.join(realDir, 'ok2.txt'), 'utf8')).resolves.toBe('good2')
  })
})

describe('readFile / writeFile — symlink escape (RED before hardening)', () => {
  it('refuses to readFile through a symlink pointing outside the root', async () => {
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(secret, 'TOP SECRET', 'utf8')
    // Symlink lives *inside* the root but targets a file outside it.
    await fs.symlink(secret, inRoot('link.txt'), 'file')

    await expectRejectCode(readFile(projectRoot, inRoot('link.txt')), 'EACCES')
  })

  it('refuses to writeFile through a symlink pointing outside the root', async () => {
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(secret, 'original', 'utf8')
    await fs.symlink(secret, inRoot('link.txt'), 'file')

    await expectRejectCode(writeFile(projectRoot, inRoot('link.txt'), 'OVERWRITTEN'), 'EACCES')
    // The outside file must be untouched.
    await expect(fs.readFile(secret, 'utf8')).resolves.toBe('original')
  })

  it('refuses to writeFile a new file whose parent is a symlinked dir escaping the root', async () => {
    // proj/escape -> outside ; writing proj/escape/new.txt lands in outside/.
    await fs.symlink(outside, inRoot('escape'), 'dir')
    await expectRejectCode(writeFile(projectRoot, inRoot('escape', 'new.txt'), 'leak'), 'EACCES')
    // Nothing leaked into the outside dir.
    await expect(fs.readdir(outside)).resolves.toEqual([])
  })

  it('refuses a deep write through a symlinked dir WITHOUT any mkdir side-effect outside the root', async () => {
    // proj/escape -> outside (an existing symlink). Writing
    // proj/escape/new/deep.txt is lexically inside the root, but the
    // deepest existing ancestor (proj/escape) realpaths to /outside. The
    // write must be rejected BEFORE any `mkdir -p` runs, so /outside/new
    // must NOT be created (no out-of-sandbox side-effect).
    await fs.symlink(outside, inRoot('escape'), 'dir')
    await expectRejectCode(writeFile(projectRoot, inRoot('escape', 'new', 'deep.txt'), 'leak'), 'EACCES')
    // The smoking gun: the mkdir side-channel must have created nothing outside.
    expect(existsSync(path.join(outside, 'new'))).toBe(false)
    await expect(fs.readdir(outside)).resolves.toEqual([])
  })

  it('creates multi-level new parent dirs for a legit deep write inside the root', async () => {
    // x/ and y/ do not exist yet; the deepest existing ancestor is the root
    // itself, which realpaths inside the root, so the write must succeed and
    // the intermediate dirs must be created in-root.
    await writeFile(projectRoot, inRoot('x', 'y', 'z.txt'), 'deep-ok')
    await expect(fs.readFile(inRoot('x', 'y', 'z.txt'), 'utf8')).resolves.toBe('deep-ok')
    // The dirs landed inside the root, not anywhere outside it.
    await expect(fs.stat(inRoot('x', 'y'))).resolves.toBeTruthy()
  })
})

describe('readFile / writeFile — TOCTOU: final component swapped to a symlink', () => {
  // THREAT MODEL. The handlers validate a path and then `open` it within the
  // *same* call, so an attacker who can race the two would swap the final
  // path component for a symlink-to-outside *after* the containment check has
  // passed but *before* the open. There is no API seam to inject that race
  // deterministically, so we model the worst case statically: the final
  // component IS a symlink pointing at `outside/secret.txt` at open time. The
  // canonical defence against this is `O_NOFOLLOW` on the final open, which
  // fails with `ELOOP` when the component it would open is a symlink.
  //
  // SECURITY INVARIANT (what actually matters): regardless of WHICH errno the
  // sandbox uses to refuse, the operation must NOT cross the boundary — a read
  // must not return the secret, and a write must not mutate the outside file.
  // Those `secret`-content assertions below are the load-bearing checks.
  //
  // OBSERVED ERRNO. The current implementation refuses these with `EACCES`,
  // not `ELOOP`: `resolveWithinProjectRoot` runs `fs.realpath` on the target
  // *before* any open, the symlink resolves to `outside/secret.txt`, the
  // containment check fails, and it throws `EACCES` — the open (and thus
  // `O_NOFOLLOW`/`ELOOP`) is never reached. We assert the observed `EACCES`
  // here; see the report for the ELOOP-vs-EACCES discrepancy.

  it('refuses readFile when the final component is a symlink escaping the root, leaking nothing', async () => {
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(secret, 'TOP SECRET', 'utf8')
    // Pre-plant a *real* file, then swap it for a symlink-to-outside so the
    // final component (`proj/file.txt`) is a symlink at the moment of open.
    const target = inRoot('file.txt')
    await fs.writeFile(target, 'innocent', 'utf8')
    await fs.rm(target)
    await fs.symlink(secret, target, 'file')

    await expectRejectCode(readFile(projectRoot, target), 'EACCES')
    // The smoking gun: the call must not have returned the secret contents.
    await expect(readFile(projectRoot, target)).rejects.toThrow()
  })

  it('refuses writeFile(overwrite) through a final-component symlink, leaving the outside file untouched', async () => {
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(secret, 'original', 'utf8')
    // proj/file.txt is a symlink to outside/secret.txt at open time.
    await fs.symlink(secret, inRoot('file.txt'), 'file')

    await expectRejectCode(writeFile(projectRoot, inRoot('file.txt'), 'HACKED'), 'EACCES')
    // The outside secret must be byte-for-byte unchanged.
    await expect(fs.readFile(secret, 'utf8')).resolves.toBe('original')
  })

  it('refuses writeFile(new file) through a final-component symlink, leaving the outside file untouched', async () => {
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(secret, 'original', 'utf8')
    // proj/b.txt is itself the symlink-to-outside; the write must not follow it.
    await fs.symlink(secret, inRoot('b.txt'), 'file')

    await expectRejectCode(writeFile(projectRoot, inRoot('b.txt'), 'HACKED'), 'EACCES')
    await expect(fs.readFile(secret, 'utf8')).resolves.toBe('original')
  })
})

describe('readFile / writeFile — IN-ROOT symlink: O_NOFOLLOW does NOT engage (behaviour lock)', () => {
  // FIX2 FOLLOW-UP — DISCREPANCY DOCUMENTED. The intent of this block was to
  // prove `O_NOFOLLOW` deterministically rejects a final-component symlink with
  // `ELOOP`, using an in-root link → in-root real file (so the realpath
  // containment check passes and only the final `open` can refuse it).
  //
  // It does NOT. `resolveWithinProjectRoot` runs `fs.realpath(target)` BEFORE
  // the open and returns the *canonical* path (`proj/real.txt`); `readFile` /
  // `writeFile` then `open(... O_NOFOLLOW)` on that already-resolved real path,
  // which is a regular file, so `O_NOFOLLOW` never sees a symlink and never
  // fires. The in-root symlink is transparently FOLLOWED.
  //
  // CONSEQUENCE: `O_NOFOLLOW` only protects the razor-thin TOCTOU window where
  // the final component is swapped to a symlink *between* the realpath check
  // and the open — a race with no deterministic test seam. For any symlink
  // that already exists at validation time, behaviour is decided by the
  // realpath step (in-root target ⇒ followed; out-of-root target ⇒ EACCES),
  // NOT by `O_NOFOLLOW`. See the report's "ELOOP vs reality" note.
  //
  // These cases LOCK that observed behaviour so it can't drift silently: if
  // the resolver is ever changed to open the original (un-resolved) path,
  // these will flip to `ELOOP` and force a deliberate update here.

  it('readFile of an in-root symlink → in-root real file FOLLOWS the link (returns target content)', async () => {
    await fs.writeFile(inRoot('real.txt'), 'in-root payload', 'utf8')
    // Both link and target are inside the root → realpath containment passes.
    await fs.symlink(inRoot('real.txt'), inRoot('link.txt'), 'file')

    // OBSERVED: the read succeeds and returns the target's content — the
    // pre-open realpath resolved the link, so O_NOFOLLOW opened `real.txt`.
    await expect(readFile(projectRoot, inRoot('link.txt'))).resolves.toBe('in-root payload')
  })

  it('writeFile through an in-root symlink → in-root real file FOLLOWS the link (mutates the target)', async () => {
    await fs.writeFile(inRoot('real.txt'), 'in-root payload', 'utf8')
    await fs.symlink(inRoot('real.txt'), inRoot('link.txt'), 'file')

    // OBSERVED: the write succeeds and lands on the resolved in-root target.
    await writeFile(projectRoot, inRoot('link.txt'), 'OVERWRITE')
    await expect(fs.readFile(inRoot('real.txt'), 'utf8')).resolves.toBe('OVERWRITE')
  })
})

describe('pickWriteRoot — accept current ∪ last-closed root (in-flight write on project close)', () => {
  // REGRESSION GUARDED: closing a project tears down `currentProjectPath`
  // (`workspace.closeProject()` sets it to '') BEFORE the renderer navigates
  // away. A debounced/teardown write that was already in flight at that moment
  // resolves its root via `getRoot()` === '' and is rejected with ENOACTIVE —
  // the developer's last edit is lost on close even though it targeted the
  // just-closed project.
  //
  // FIX DIRECTION: `writeFile` should accept a path that lives under the
  // CURRENT root OR under the LAST-CLOSED project root (recorded by
  // workspace-service in `closeProject`, reset in `openProject`). Crucially
  // this must NOT relax the sandbox: whichever root is selected, the existing
  // realpath containment / `assertWritableAncestor` / `O_NOFOLLOW` defences
  // still apply against THAT root.
  //
  // ── SEAM ──────────────────────────────────────────────────────────────────
  //   __testing.pickWriteRoot(
  //     absPath: string,
  //     roots: { current: string; lastClosed: string },
  //   ): string
  //
  //   • Returns the project root (`current` or `lastClosed`) that lexically
  //     CONTAINS `absPath` — preferring `current` when `absPath` is inside both.
  //   • An empty-string root ('') means "no such root" and is never selected.
  //   • Throws when `absPath` is inside NEITHER root: ENOACTIVE when both roots
  //     are empty (no project context at all), otherwise EACCES (the path
  //     escapes every known sandbox root).
  //   • Containment uses the same lexical `path.resolve` + `path.sep`-aware
  //     check as `enforceWithinProjectRoot` (no fs I/O here — symlink/realpath
  //     hardening stays in `resolveWithinProjectRoot`, applied to the returned
  //     root by the caller).
  // ──────────────────────────────────────────────────────────────────────────

  const pickWriteRoot = (
    __testing as unknown as {
      pickWriteRoot?: (abs: string, roots: { current: string; lastClosed: string }) => string
    }
  ).pickWriteRoot

  it('selects last-closed root when current is empty (project just closed)', () => {
    // current='' (closeProject cleared it), lastClosed='/proj'; the in-flight
    // write to /proj/a.txt must still resolve against /proj.
    const picked = pickWriteRoot!(inRoot('a.txt'), { current: '', lastClosed: projectRoot })
    expect(picked).toBe(projectRoot)
    // And the picked root must actually work end-to-end through the sandbox.
    return writeFile(picked, inRoot('a.txt'), 'flushed-on-close').then(() =>
      expect(fs.readFile(inRoot('a.txt'), 'utf8')).resolves.toBe('flushed-on-close'),
    )
  })

  it('selects last-closed root for a path under it while a different project is current', async () => {
    // current='/new' (a freshly-opened project), lastClosed='/old'; a write to
    // an /old path (a late flush from the previous project) picks /old.
    const oldRoot = path.join(workdir, 'old')
    const newRoot = path.join(workdir, 'new')
    await fs.mkdir(oldRoot, { recursive: true })
    await fs.mkdir(newRoot, { recursive: true })
    const target = path.join(oldRoot, 'x.txt')

    const picked = pickWriteRoot!(target, { current: newRoot, lastClosed: oldRoot })
    expect(picked).toBe(oldRoot)
    await writeFile(picked, target, 'late-flush')
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('late-flush')
  })

  it('prefers current over last-closed when the path is inside both', () => {
    // Degenerate but well-defined: same dir is both current and lastClosed →
    // current wins (the selector must be deterministic, not order-dependent).
    const picked = pickWriteRoot!(inRoot('a.txt'), { current: projectRoot, lastClosed: projectRoot })
    expect(picked).toBe(projectRoot)
  })

  it('throws when the path is inside NEITHER root', () => {
    // A path under neither current nor lastClosed is rejected. Both roots
    // present but non-matching ⇒ EACCES (escapes every known sandbox root).
    const stray = path.join(outside, 'f.txt')
    expectCode(() => pickWriteRoot!(stray, { current: projectRoot, lastClosed: projectRoot }), 'EACCES')
  })

  it('throws ENOACTIVE when there is no current AND no last-closed root', () => {
    expectCode(() => pickWriteRoot!(inRoot('a.txt'), { current: '', lastClosed: '' }), 'ENOACTIVE')
  })

  // ── SANDBOX MUST NOT RELAX even when the matched root is the last-closed one ──
  // Each of these reuses an escape fixture from the suite above, but validates
  // it against `lastClosed` (current empty). The selector picks `lastClosed`,
  // then the SAME containment / ancestor / O_NOFOLLOW defences must still
  // reject the escape with EACCES — last-closed acceptance is purely about
  // WHICH root, never about loosening WHAT is allowed inside it.

  it('still rejects a `..` escape when validated against the last-closed root', () => {
    // `inRoot('..','outside','f.txt')` resolves to `outside/f.txt`, which is
    // inside NEITHER root → pickWriteRoot must reject it (EACCES) so no write
    // is ever attempted against the last-closed root.
    expectCode(
      () => pickWriteRoot!(inRoot('..', 'outside', 'f.txt'), { current: '', lastClosed: projectRoot }),
      'EACCES',
    )
  })

  it('still rejects a symlink-escape write when validated against the last-closed root', async () => {
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(secret, 'original', 'utf8')
    await fs.symlink(secret, inRoot('link.txt'), 'file')

    const picked = pickWriteRoot!(inRoot('link.txt'), { current: '', lastClosed: projectRoot })
    expect(picked).toBe(projectRoot)
    // Lexically in-root, but realpath resolves outside → still EACCES.
    await expectRejectCode(writeFile(picked, inRoot('link.txt'), 'HACKED'), 'EACCES')
    await expect(fs.readFile(secret, 'utf8')).resolves.toBe('original')
  })

  it('still rejects a mkdir side-channel write when validated against the last-closed root', async () => {
    // proj/escape -> outside; deep write must be refused with no mkdir leak.
    await fs.symlink(outside, inRoot('escape'), 'dir')
    const picked = pickWriteRoot!(inRoot('escape', 'new', 'deep.txt'), { current: '', lastClosed: projectRoot })
    expect(picked).toBe(projectRoot)
    await expectRejectCode(writeFile(picked, inRoot('escape', 'new', 'deep.txt'), 'leak'), 'EACCES')
    expect(existsSync(path.join(outside, 'new'))).toBe(false)
    await expect(fs.readdir(outside)).resolves.toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// LIVE CONTRACT — these tests exercise behaviour the implementation provides:
// (A) a synchronous sandboxed writer `__testing.writeFileSync` and
// (B) post-open mid-path TOCTOU re-verification on every read/write path.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Adapter so the same assertions can drive BOTH writers. The async writer is
 * awaited; the sync writer is invoked directly and wrapped so callers can
 * `await` a uniform Promise (a throw becomes a rejection). The sync writer is
 * read off `__testing` and typed via a cast so the same assertions apply
 * uniformly to both writers.
 */
const writeFileSync = (
  __testing as unknown as {
    writeFileSync?: (root: string, abs: string, content: string) => void
  }
).writeFileSync

type Writer = {
  name: string
  /** Drive the writer uniformly; rejects with the same Error the impl throws. */
  write: (root: string, abs: string, content: string) => Promise<void>
}

const WRITERS: Writer[] = [
  {
    name: 'async writeFile',
    write: (root, abs, content) => writeFile(root, abs, content),
  },
  {
    name: 'sync writeFileSync',
    // Wrap the synchronous call: a throw must surface as a rejection so the
    // shared `expectRejectCode` helper works for both writers.
    write: (root, abs, content) =>
      new Promise<void>((resolve, reject) => {
        try {
          writeFileSync!(root, abs, content)
          resolve()
        } catch (err) {
          reject(err)
        }
      }),
  },
]

describe('writeFile parity — async writeFile ≡ sync writeFileSync (same guards, same errors)', () => {
  for (const w of WRITERS) {
    describe(w.name, () => {
      it('writes a normal file inside the root and the bytes round-trip', async () => {
        await w.write(projectRoot, inRoot('parity.txt'), 'round-trip')
        await expect(fs.readFile(inRoot('parity.txt'), 'utf8')).resolves.toBe('round-trip')
        // And it is readable back through the sandbox reader too.
        await expect(readFile(projectRoot, inRoot('parity.txt'))).resolves.toBe('round-trip')
      })

      it('creates missing intermediate parent dirs (a/b/c.txt)', async () => {
        await w.write(projectRoot, inRoot('a', 'b', 'c.txt'), 'deep')
        await expect(fs.readFile(inRoot('a', 'b', 'c.txt'), 'utf8')).resolves.toBe('deep')
        await expect(fs.stat(inRoot('a', 'b'))).resolves.toBeTruthy()
      })

      it('rejects EACCES on a `..` escape', async () => {
        await expectRejectCode(
          w.write(projectRoot, inRoot('..', 'outside', 'f.txt'), 'leak'),
          'EACCES',
        )
        await expect(fs.readdir(outside)).resolves.toEqual([])
      })

      it('rejects EACCES on a final-component symlink pointing outside the root', async () => {
        const secret = path.join(outside, 'secret.txt')
        await fs.writeFile(secret, 'original', 'utf8')
        // proj/file.txt IS a symlink to outside/secret.txt at open time.
        await fs.symlink(secret, inRoot('file.txt'), 'file')

        await expectRejectCode(w.write(projectRoot, inRoot('file.txt'), 'HACKED'), 'EACCES')
        // The outside secret must be byte-for-byte unchanged.
        await expect(fs.readFile(secret, 'utf8')).resolves.toBe('original')
      })

      it('rejects EACCES on a symlink-inside-root pointing outside the root', async () => {
        // proj/escape -> outside ; writing proj/escape/new.txt lands outside.
        await fs.symlink(outside, inRoot('escape'), 'dir')
        await expectRejectCode(w.write(projectRoot, inRoot('escape', 'new.txt'), 'leak'), 'EACCES')
        // Nothing leaked into the outside dir, and no mkdir side-effect.
        expect(existsSync(path.join(outside, 'new.txt'))).toBe(false)
        await expect(fs.readdir(outside)).resolves.toEqual([])
      })

      it('rejects EINVAL on a NUL byte in the path', async () => {
        await expectRejectCode(w.write(projectRoot, inRoot('a\0b.txt'), 'x'), 'EINVAL')
      })

      it('rejects EINVAL on an empty path', async () => {
        await expectRejectCode(w.write(projectRoot, '', 'x'), 'EINVAL')
      })

      it('rejects ENOACTIVE on an empty root (no project open)', async () => {
        await expectRejectCode(w.write('', inRoot('f.txt'), 'x'), 'ENOACTIVE')
      })
    })
  }
})

describe('TOCTOU mid-path detection — directory component swapped to a symlink at open time', () => {
  // THREAT MODEL (the headline new behaviour). `O_NOFOLLOW` only guards the
  // FINAL path component. A MID-PATH directory component (`root/mid`) can be
  // `rm`'d and replaced with a symlink-to-outside in the window between the
  // pre-open realpath validation and the actual `open`. The hardened impl must
  // RE-VERIFY (re-realpath) the resolved path is STILL inside the root AFTER
  // the open — before returning bytes (read) or writing content (write) — and
  // refuse with EACCES if it has escaped. For writes the open must NOT use
  // O_TRUNC; truncation+write only happen AFTER the re-verification passes, so
  // a DETECTED race writes NONE of the user's content to the out-of-root file.
  //
  // We make the attacker win DETERMINISTICALLY by spying the open seam: exactly
  // when the impl opens the file, the real dir `root/mid` is first replaced
  // with a symlink to `<outside>`, THEN the real open is delegated to. The swap
  // therefore happens strictly between the pre-open realpath and the open.

  /** Build `root/mid/target.txt` and an out-of-root `outside/target.txt` (SENTINEL). */
  async function buildMidPathFixture(): Promise<{
    midDir: string
    target: string
    outsideTarget: string
    swap: () => void
  }> {
    const midDir = inRoot('mid')
    await fs.mkdir(midDir, { recursive: true })
    const target = path.join(midDir, 'target.txt')
    await fs.writeFile(target, 'in-root original', 'utf8')

    const outsideTarget = path.join(outside, 'target.txt')
    await fs.writeFile(outsideTarget, 'SENTINEL', 'utf8')

    // The race: drop the real `mid` dir and point it at `outside`, so the
    // already-validated path `root/mid/target.txt` now resolves to
    // `outside/target.txt`. Done synchronously inside the open spy.
    const swap = () => {
      nodeFs.rmSync(midDir, { recursive: true, force: true })
      nodeFs.symlinkSync(outside, midDir, 'dir')
    }
    return { midDir, target, outsideTarget, swap }
  }

  afterEach(() => {
    // Drop any injected race so the next test sees the real fs again.
    __fsHooks.open = undefined
    __fsHooks.realpath = undefined
    vi.restoreAllMocks()
  })

  /**
   * Install a ONE-SHOT async-open race: on the first `fs.open` the impl makes,
   * run `swap()` (mid-path dir → symlink-to-outside) and then delegate to the
   * real open; subsequent opens pass straight through.
   */
  function installAsyncOpenRace(swap: () => void): void {
    // Delegate to the REAL open (not `fs.open`, which re-consults `__fsHooks.open`
    // and would recurse forever — the harness fix that makes this race work).
    const realOpen = (fs as unknown as { __actualOpen: (...a: unknown[]) => unknown }).__actualOpen
    let fired = false
    __fsHooks.open = (...args: unknown[]) => {
      if (!fired) {
        fired = true
        // Attacker wins the race in the pre-open / open gap.
        swap()
      }
      return realOpen(...args)
    }
  }

  it('readFile (async) rejects EACCES and leaks nothing when a mid-path dir is swapped at open', async () => {
    const { target, swap } = await buildMidPathFixture()
    installAsyncOpenRace(swap)

    await expectRejectCode(readFile(projectRoot, target), 'EACCES')
  })

  it('writeFile (async) rejects EACCES and does NOT write into the out-of-root target', async () => {
    const { target, outsideTarget, swap } = await buildMidPathFixture()
    installAsyncOpenRace(swap)

    await expectRejectCode(writeFile(projectRoot, target, 'HACKED'), 'EACCES')
    // The smoking gun: the user's content must NOT have reached the out-of-root
    // file — the SENTINEL is intact (no O_TRUNC, no write before re-verify).
    await expect(fs.readFile(outsideTarget, 'utf8')).resolves.toBe('SENTINEL')
  })

  it('writeFileSync (sync) rejects EACCES and does NOT write into the out-of-root target', async () => {
    const { target, outsideTarget, swap } = await buildMidPathFixture()

    // Spy the sync open seam (node:fs openSync) for the synchronous writer; the
    // CJS `node:fs` default object is configurable, so vi.spyOn works here.
    const realOpenSync = nodeFs.openSync
    vi.spyOn(nodeFs, 'openSync').mockImplementationOnce(((
      ...args: Parameters<typeof realOpenSync>
    ) => {
      swap()
      return (realOpenSync as (...a: unknown[]) => number)(...args)
    }) as typeof realOpenSync)

    await expectRejectCode(
      WRITERS.find((w) => w.name === 'sync writeFileSync')!.write(projectRoot, target, 'HACKED'),
      'EACCES',
    )
    await expect(fs.readFile(outsideTarget, 'utf8')).resolves.toBe('SENTINEL')
  })

  // ── FALLBACK SIMULATION (realpath seam) ──────────────────────────────────
  // If the impl does not route through an open seam the hook above can observe,
  // the same race is modelled by making the POST-OPEN re-verification realpath
  // return an OUT-OF-ROOT path while the PRE-OPEN validation realpath(s)
  // returned IN-ROOT. The hardened impl must reject on that post-open mismatch.
  it('readFile (async) rejects EACCES when the target realpath reports an out-of-root path', async () => {
    const { target, outsideTarget } = await buildMidPathFixture()

    // Delegate truthful calls to the REAL realpath (not the wrapper, which would
    // re-consult this hook and corrupt the call count). The realpath of the ROOT
    // stays truthful (in-root); the realpath of the TARGET reports out-of-root,
    // modelling a mid-path component that now resolves outside the sandbox. The
    // containment check then rejects with EACCES. (The genuinely POST-open swap
    // — symlink in place only across the open — is covered deterministically by
    // the open-seam tests above; a realpath hook can't isolate post-open here
    // because the target is also realpath'd pre-open.)
    const realRealpath = (fs as unknown as { __actualRealpath: (...a: unknown[]) => Promise<string> })
      .__actualRealpath
    __fsHooks.realpath = (...args: unknown[]) => {
      const p = path.resolve(String(args[0]))
      if (p === path.resolve(target)) {
        return Promise.resolve(outsideTarget)
      }
      return realRealpath(...args)
    }

    await expectRejectCode(readFile(projectRoot, target), 'EACCES')
  })
})

describe('TOCTOU hardening — no false reject on the happy path (re-verification must not break normal I/O)', () => {
  // Guards against the post-open re-verification over-firing: a NORMAL read and
  // a NORMAL write (no race, no spies) must still succeed with no spurious
  // EACCES once the hardening lands.
  it('a normal read still succeeds under post-open re-verification', async () => {
    await fs.writeFile(inRoot('plain.txt'), 'plain payload', 'utf8')
    await expect(readFile(projectRoot, inRoot('plain.txt'))).resolves.toBe('plain payload')
  })

  it('a normal async write still succeeds under post-open re-verification', async () => {
    await writeFile(projectRoot, inRoot('plain-out.txt'), 'written')
    await expect(fs.readFile(inRoot('plain-out.txt'), 'utf8')).resolves.toBe('written')
  })

  it('a normal sync write still succeeds under post-open re-verification', async () => {
    await WRITERS.find((w) => w.name === 'sync writeFileSync')!.write(
      projectRoot,
      inRoot('plain-sync.txt'),
      'written-sync',
    )
    await expect(fs.readFile(inRoot('plain-sync.txt'), 'utf8')).resolves.toBe('written-sync')
  })
})

describe('write completes the whole buffer across a short write (no truncated content)', () => {
  // The writer writes at offset 0 then truncates to byte length; a single
  // `write`/`writeSync` may persist FEWER bytes than requested, so the impl
  // loops until the buffer is fully written. Force a short first write on the
  // sync seam and assert the full content still lands (not new-prefix+zeros).
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sync writeFileSync persists the full buffer when the first writeSync is short', async () => {
    const content = 'abcdefghij' // 10 bytes
    const realWriteSync = nodeFs.writeSync
    let first = true
    vi.spyOn(nodeFs, 'writeSync').mockImplementation(((
      fd: number,
      buf: NodeJS.ArrayBufferView,
      off: number,
      _len: number,
      pos: number,
    ) => {
      if (first) {
        first = false
        // Persist only 3 bytes on the first call; the loop must write the rest.
        return (realWriteSync as (...a: unknown[]) => number)(fd, buf, off, 3, pos)
      }
      return (realWriteSync as (...a: unknown[]) => number)(fd, buf, off, _len, pos)
    }) as typeof nodeFs.writeSync)

    await WRITERS.find((w) => w.name === 'sync writeFileSync')!.write(
      projectRoot,
      inRoot('short.txt'),
      content,
    )
    await expect(fs.readFile(inRoot('short.txt'), 'utf8')).resolves.toBe(content)
  })
})
