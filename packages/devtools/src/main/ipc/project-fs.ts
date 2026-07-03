/**
 * Sandboxed project file-system IPC for the in-renderer Monaco editor.
 *
 * Replaces the OpenSumi editor's `editor:fs:*` bridge (which was gated to a
 * separate WebContentsView via an allow-list). The Monaco editor now lives
 * in the MAIN renderer, so these channels run under the standard workbench
 * sender policy (`ctx.senderPolicy`) — the main window is already trusted.
 *
 * Sandbox: every path is resolved and verified against the live active
 * project root (`ctx.workspace.getProjectPath()`, read per-call so project
 * switches take effect immediately). `..`/escapes throw `EACCES`; no open
 * project throws `ENOACTIVE`. Symlinks ARE resolved: both the root and the
 * target go through `fs.realpath` before the containment check, so a symlink
 * inside the root that points outside it (`proj/link -> ../secret`) cannot be
 * used to read or write past the sandbox. Writes additionally verify the
 * deepest existing ancestor directory with `fs.realpath` BEFORE any `mkdir`,
 * so a symlinked-out parent cannot leak a `mkdir -p` side-effect (a directory
 * created outside the sandbox) ahead of the containment check.
 *
 * TOCTOU hardening (two layers):
 *   1. The final `open` uses `O_NOFOLLOW`, so a FINAL path component swapped to
 *      a symlink between the realpath check and the open is refused instead of
 *      followed out of the sandbox.
 *   2. After the open, the resolved path is re-`realpath`'d and re-checked
 *      against the root BEFORE any bytes are returned (read) or written (write).
 *      This catches a MID-PATH directory component swapped to a symlink in the
 *      same window — which `O_NOFOLLOW` does NOT guard. Writes open with
 *      `O_CREAT` but WITHOUT `O_TRUNC`, and only truncate+write once this
 *      re-check passes, so a detected mid-path race never writes the user's
 *      content to an out-of-sandbox target (at worst it leaves a zero-byte file
 *      if `O_CREAT` created one at the swapped location).
 *
 * Residual: a perfectly-timed swap-and-restore that puts the mid-path symlink
 * in place only for the open and reverts it before the post-open realpath would
 * evade detection. Provably closing that needs per-component `openat` /
 * `F_GETPATH`-style resolution, which portable Node does not expose — an
 * accepted residual under this dev-tool threat model (the main window is
 * already trusted and there is no adversary racing the local filesystem).
 *
 * The same defences are mirrored synchronously in `writeFileSync` for the
 * editor's `beforeunload` flush (`ProjectFsChannel.WriteFileSync`).
 */
import fs from 'node:fs/promises'
import nodeFs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { validate } from '../utils/ipc-schema.js'
import { ProjectFsChannel } from '../../shared/ipc-channels.js'

/** Cap for `listFiles` — huge monorepos would otherwise stall the renderer. */
const LIST_FILE_LIMIT = 5000

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '.next', '.cache', '.turbo', '.parcel-cache', '.nuxt', '.output', '.vite',
])

const PathArg = z.string().min(1)
const ReadFileSchema = z.tuple([PathArg])
const WriteFileSchema = z.tuple([PathArg, z.string()])
const ListFilesSchema = z.tuple([PathArg])

function makeError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code?: string }
  err.code = code
  return err
}

/** `true` if `child` is `parent` itself or lives strictly under it. */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true
  const rel = path.relative(parent, child)
  // `rel` empty == same dir; `..`-prefixed or absolute == outside.
  return rel.length > 0 && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

/**
 * Synchronous, string-level guard: reject empty root (ENOACTIVE), NUL bytes
 * and empty paths (EINVAL), and lexical `..` escapes (EACCES) by resolving
 * both sides with `path.resolve` and a `path.sep`-aware containment check
 * (so `/foo/bar` ⊄ `/foo/bar2`). This is the cheap first pass; it does NOT
 * resolve symlinks — that is done by `resolveWithinProjectRoot` below.
 */
export function enforceWithinProjectRoot(abs: string, root: string): string {
  if (root === '') {
    throw makeError('ENOACTIVE', 'No active project — open a project before using the editor file system')
  }
  if (typeof abs !== 'string' || abs.length === 0) {
    throw makeError('EINVAL', 'path must be a non-empty string')
  }
  if (abs.includes('\0') || root.includes('\0')) {
    throw makeError('EINVAL', 'path must not contain NUL bytes')
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(abs)
  if (!isWithin(resolvedRoot, resolved)) {
    throw makeError('EACCES', `Path escapes project root: ${resolved}`)
  }
  return resolved
}

/**
 * Pick the project root a write should be validated against: the CURRENT root
 * or the LAST-CLOSED one (recorded by workspace-service in `closeProject`,
 * reset in `openProject`). This rescues an in-flight teardown/debounced write
 * whose target lives under the project that was just closed — `closeProject`
 * clears `currentProjectPath` to '' BEFORE the renderer navigates away, so a
 * write resolving its root via the live root alone would be rejected with
 * ENOACTIVE and the developer's last edit lost.
 *
 * Selection is purely LEXICAL (same `path.resolve` + `path.sep`-aware
 * containment as `enforceWithinProjectRoot`, no fs I/O): symlink/realpath
 * hardening stays in the downstream `resolveWithinProjectRoot` /
 * `assertWritableAncestor` defences, applied by the caller against the root
 * this returns — so accepting the last-closed root never relaxes the sandbox.
 *
 *  - Returns whichever root lexically contains `absPath`, preferring `current`.
 *  - An empty-string root ('') means "no such root" and is never selected.
 *  - Throws when `absPath` is inside NEITHER root: ENOACTIVE when both roots
 *    are empty (no project context at all), otherwise EACCES (the path escapes
 *    every known sandbox root).
 */
export function pickWriteRoot(
  absPath: string,
  roots: { current: string; lastClosed: string },
): string {
  const resolved = path.resolve(absPath)
  if (roots.current !== '' && isWithin(path.resolve(roots.current), resolved)) {
    return roots.current
  }
  if (roots.lastClosed !== '' && isWithin(path.resolve(roots.lastClosed), resolved)) {
    return roots.lastClosed
  }
  if (roots.current === '' && roots.lastClosed === '') {
    throw makeError('ENOACTIVE', 'No active project — open a project before using the editor file system')
  }
  throw makeError('EACCES', `Path escapes project root: ${resolved}`)
}

/**
 * Symlink-aware resolution: run the cheap lexical guard, then `fs.realpath`
 * BOTH the root and the target before re-checking containment. This closes
 * the symlink-escape hole — a link inside the root that points outside it
 * resolves to an out-of-root real path and is rejected with EACCES.
 *
 * Writing a not-yet-existing file would make `realpath(target)` throw ENOENT,
 * so when the target is missing we realpath its PARENT directory and re-join
 * the basename: the file's containing directory must itself be inside the
 * (realpath'd) root.
 */
export async function resolveWithinProjectRoot(abs: string, root: string): Promise<string> {
  // Lexical guard first (handles ENOACTIVE / EINVAL / `..` before any fs I/O).
  const lexical = enforceWithinProjectRoot(abs, root)
  const realRoot = await fs.realpath(path.resolve(root))

  let realTarget: string
  try {
    realTarget = await fs.realpath(lexical)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // Target does not exist yet (e.g. first write): the parent dir must.
    const parent = path.dirname(lexical)
    const realParent = await fs.realpath(parent)
    if (!isWithin(realRoot, realParent)) {
      throw makeError('EACCES', `Path escapes project root: ${lexical}`)
    }
    return path.join(realParent, path.basename(lexical))
  }

  if (!isWithin(realRoot, realTarget)) {
    throw makeError('EACCES', `Path escapes project root: ${realTarget}`)
  }
  return realTarget
}

/**
 * Post-open TOCTOU re-verification: re-`realpath` the already-opened path and
 * re-check containment. `O_NOFOLLOW` guards only the FINAL component, so a
 * MID-PATH directory component swapped to a symlink in the realpath→open window
 * would still be followed out of the sandbox. Re-resolving here AFTER the open
 * catches that swap — callers run it before returning/writing bytes and reject
 * on failure. (Residual: a swap reverted before this re-resolve; see file head.)
 */
async function assertOpenedWithinRoot(safe: string, root: string): Promise<void> {
  const realRoot = await fs.realpath(path.resolve(root))
  const real = await fs.realpath(safe)
  if (!isWithin(realRoot, real)) {
    throw makeError('EACCES', `Path escapes project root (mid-path race): ${real}`)
  }
}

export async function readFile(root: string, p: string): Promise<string> {
  const safe = await resolveWithinProjectRoot(p, root)
  // Open with O_NOFOLLOW so a final-component symlink swapped in AFTER the
  // realpath containment check (the TOCTOU race) is not followed out of the
  // sandbox. Operate on the FileHandle, never a second path-based open (which
  // would re-follow the swapped symlink).
  const fh = await fs.open(safe, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    // Re-verify post-open: catches a mid-path component swapped to a symlink in
    // the realpath→open window (which O_NOFOLLOW does not guard). Reject before
    // returning any bytes, so an escaped read leaks nothing.
    await assertOpenedWithinRoot(safe, root)
    return await fh.readFile('utf8')
  } finally {
    await fh.close()
  }
}

/**
 * Raw-byte twin of {@link readFile}: same realpath containment + `O_NOFOLLOW`
 * + post-open re-check, returning a Buffer for binary-safe callers (the COI
 * `/__fs/read` bridge serves arbitrary file bytes, not just utf8 text).
 */
export async function readFileBuffer(root: string, p: string): Promise<Buffer> {
  const safe = await resolveWithinProjectRoot(p, root)
  const fh = await fs.open(safe, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    await assertOpenedWithinRoot(safe, root)
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

/**
 * Symlink-aware ancestor guard, run BEFORE any `mkdir`. Walks up from the
 * write target to the DEEPEST already-existing ancestor directory, then
 * `fs.realpath`s it and checks it is still inside the (realpath'd) root.
 *
 * This closes the `mkdir -p` write side-channel: with `proj/escape ->
 * /outside`, the lexical guard alone would let `mkdir -p proj/escape/new`
 * follow the symlink and create `/outside/new` (an out-of-sandbox side-effect)
 * before the post-mkdir realpath check could reject it. By realpath'ing the
 * deepest existing ancestor first, we reject such writes with zero mkdir.
 *
 * Legitimate deep writes (`proj/a/b/c.txt` where `a`/`b` don't exist yet)
 * walk up to the root itself — `realpath(root)` is inside the root, so they
 * pass and `mkdir -p` is allowed to create the in-root intermediate dirs.
 */
export async function assertWritableAncestor(lexical: string, root: string): Promise<void> {
  const realRoot = await fs.realpath(path.resolve(root))
  // Climb to the deepest ancestor that actually exists on disk.
  let ancestor = path.dirname(lexical)
  // Guard against an unbounded loop: `path.dirname` is a fixed point at the
  // filesystem root ('/' -> '/'), so stop once it stops changing.
  for (;;) {
    let realAncestor: string
    try {
      realAncestor = await fs.realpath(ancestor)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const next = path.dirname(ancestor)
      if (next === ancestor) {
        // Reached the filesystem root without finding an existing ancestor.
        throw makeError('EACCES', `Path escapes project root: ${lexical}`)
      }
      ancestor = next
      continue
    }
    // Deepest existing ancestor found — it must resolve inside the root.
    if (!isWithin(realRoot, realAncestor)) {
      throw makeError('EACCES', `Path escapes project root: ${lexical}`)
    }
    return
  }
}

export async function writeFile(root: string, p: string, content: string | Buffer): Promise<void> {
  // First lexical guard so a `..` escape is rejected before any fs I/O.
  const lexical = enforceWithinProjectRoot(p, root)
  // Symlink-aware ancestor check BEFORE any mkdir, so a symlinked-out parent
  // (`proj/escape -> /outside`) cannot leak a `mkdir -p` side-effect outside
  // the sandbox. Rejected writes create nothing, in or out of the root.
  await assertWritableAncestor(lexical, root)
  await fs.mkdir(path.dirname(lexical), { recursive: true })
  // Re-resolve through realpath now that the parent dir exists; final check
  // for any boundary case introduced while creating the parent dirs.
  const safe = await resolveWithinProjectRoot(p, root)
  // Open with O_NOFOLLOW (final-component symlink guard) and O_CREAT but NOT
  // O_TRUNC: truncating at open would destroy an out-of-sandbox file's contents
  // before any mid-path re-check could run. We re-verify containment first, and
  // only then truncate+write — so a detected mid-path race never mutates the
  // user's content out of the sandbox.
  const fh = await fs.open(
    safe,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o666,
  )
  try {
    // Re-verify post-open: catches a mid-path component swapped to a symlink in
    // the realpath→open window (which O_NOFOLLOW does not guard). Reject BEFORE
    // writing, so an escaped write lands none of the user's content.
    await assertOpenedWithinRoot(safe, root)
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    // Write the whole buffer at absolute offset 0, looping over any short write
    // (a single `write` may persist fewer than requested bytes), then truncate
    // to the exact length — the O_TRUNC-free replacement of prior contents.
    let off = 0
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off, off)
      if (bytesWritten <= 0) break
      off += bytesWritten
    }
    await fh.truncate(buf.length)
  } finally {
    await fh.close()
  }
}

/**
 * Join a project-root-RELATIVE bridge path onto `root` so the guards resolve it
 * against the project, not `process.cwd()`. `enforceWithinProjectRoot` runs
 * `path.resolve(abs)`, which would resolve a bare relative path against the
 * main-process cwd and wrongly reject every legitimate in-root file. An empty
 * root is passed through unchanged so the guard still raises ENOACTIVE first.
 */
function joinRel(root: string, rel: string): string {
  if (root === '') return ''
  return path.resolve(root, rel)
}

/**
 * Directory metadata twin of {@link readFile}: realpath-contain the target
 * before `fs.stat` so a symlink inside the root pointing outside it cannot leak
 * out-of-sandbox metadata. `rel` is a project-root-relative bridge path.
 */
export async function statWithin(root: string, rel: string): Promise<import('node:fs').Stats> {
  const safe = await resolveWithinProjectRoot(joinRel(root, rel), root)
  return fs.stat(safe)
}

/** Realpath-contained `fs.readdir` twin (see {@link statWithin}). */
export async function readdirWithin(
  root: string,
  rel: string,
): Promise<import('node:fs').Dirent[]> {
  const safe = await resolveWithinProjectRoot(joinRel(root, rel), root)
  return fs.readdir(safe, { withFileTypes: true })
}

/**
 * Raw-byte read twin of {@link readFileBuffer} taking a project-root-relative
 * bridge path (the COI `/__fs/read` bridge), with the same realpath +
 * `O_NOFOLLOW` + post-open re-check sandbox.
 */
export async function readFileBufferWithin(root: string, rel: string): Promise<Buffer> {
  return readFileBuffer(root, joinRel(root, rel))
}

/**
 * Whole-file write taking a project-root-relative bridge path (the COI
 * `/__fs/write` bridge); delegates to {@link writeFile} with the full sandbox.
 */
export async function writeFileWithin(root: string, rel: string, content: Buffer): Promise<void> {
  return writeFile(root, joinRel(root, rel), content)
}

/**
 * Realpath-aware `mkdir -p`: run the same writable-ancestor guard as
 * {@link writeFile} BEFORE any mkdir, so a symlinked-out parent cannot leak an
 * out-of-sandbox directory side-effect. `rel` is project-root-relative.
 */
export async function mkdirWithin(root: string, rel: string): Promise<void> {
  const lexical = enforceWithinProjectRoot(joinRel(root, rel), root)
  await assertWritableAncestor(lexical, root)
  await fs.mkdir(lexical, { recursive: true })
}

/**
 * Realpath-aware recursive delete: resolve the target through realpath so a
 * symlink inside the root pointing outside it is rejected (EACCES) rather than
 * having its target removed. A missing target is a no-op (`force: true`).
 * `rel` is project-root-relative.
 */
export async function deleteWithin(root: string, rel: string): Promise<void> {
  let safe: string
  try {
    safe = await resolveWithinProjectRoot(joinRel(root, rel), root)
  } catch (err) {
    // A not-yet-existing target realpaths its parent; if the parent itself is
    // missing the delete is a no-op (nothing to remove inside the sandbox).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  await fs.rm(safe, { recursive: true, force: true })
}

/**
 * Realpath-aware rename: contain the source via realpath and run the
 * writable-ancestor guard on the destination's parent BEFORE any mkdir, so
 * neither side can follow a symlink out of the sandbox. Both paths are
 * project-root-relative.
 */
export async function renameWithin(root: string, from: string, to: string): Promise<void> {
  const safeFrom = await resolveWithinProjectRoot(joinRel(root, from), root)
  const lexicalTo = enforceWithinProjectRoot(joinRel(root, to), root)
  await assertWritableAncestor(lexicalTo, root)
  await fs.mkdir(path.dirname(lexicalTo), { recursive: true })
  await fs.rename(safeFrom, lexicalTo)
}

// ── Synchronous mirror (editor beforeunload flush) ──────────────────────────
// The sync write path exists so the editor can flush a pending edit inside
// `beforeunload` and BLOCK until it lands (an async write loses the race with a
// hard window/app close). These functions mirror the async guards above EXACTLY
// and MUST stay in lockstep — any divergence reopens a sandbox escape on the
// sync path. They reuse the pure lexical helpers (`enforceWithinProjectRoot`,
// `isWithin`, `pickWriteRoot`, `makeError`) so the boundary is single-sourced;
// only sync-vs-async fs calls differ. All `node:fs` access goes through the
// default `nodeFs` object so the same realpath/open surface is exercised.

/** Synchronous twin of {@link resolveWithinProjectRoot}. */
function resolveWithinProjectRootSync(abs: string, root: string): string {
  const lexical = enforceWithinProjectRoot(abs, root)
  const realRoot = nodeFs.realpathSync(path.resolve(root))
  let realTarget: string
  try {
    realTarget = nodeFs.realpathSync(lexical)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const parent = path.dirname(lexical)
    const realParent = nodeFs.realpathSync(parent)
    if (!isWithin(realRoot, realParent)) {
      throw makeError('EACCES', `Path escapes project root: ${lexical}`)
    }
    return path.join(realParent, path.basename(lexical))
  }
  if (!isWithin(realRoot, realTarget)) {
    throw makeError('EACCES', `Path escapes project root: ${realTarget}`)
  }
  return realTarget
}

/** Synchronous twin of {@link assertWritableAncestor}. */
function assertWritableAncestorSync(lexical: string, root: string): void {
  const realRoot = nodeFs.realpathSync(path.resolve(root))
  let ancestor = path.dirname(lexical)
  for (;;) {
    let realAncestor: string
    try {
      realAncestor = nodeFs.realpathSync(ancestor)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const next = path.dirname(ancestor)
      if (next === ancestor) {
        throw makeError('EACCES', `Path escapes project root: ${lexical}`)
      }
      ancestor = next
      continue
    }
    if (!isWithin(realRoot, realAncestor)) {
      throw makeError('EACCES', `Path escapes project root: ${lexical}`)
    }
    return
  }
}

/** Synchronous twin of {@link assertOpenedWithinRoot}. */
function assertOpenedWithinRootSync(safe: string, root: string): void {
  const realRoot = nodeFs.realpathSync(path.resolve(root))
  const real = nodeFs.realpathSync(safe)
  if (!isWithin(realRoot, real)) {
    throw makeError('EACCES', `Path escapes project root (mid-path race): ${real}`)
  }
}

/** Synchronous twin of {@link writeFile} — identical sandbox, blocking I/O. */
function writeFileSync(root: string, p: string, content: string): void {
  const lexical = enforceWithinProjectRoot(p, root)
  assertWritableAncestorSync(lexical, root)
  nodeFs.mkdirSync(path.dirname(lexical), { recursive: true })
  const safe = resolveWithinProjectRootSync(p, root)
  const fd = nodeFs.openSync(
    safe,
    nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_NOFOLLOW,
    0o666,
  )
  try {
    assertOpenedWithinRootSync(safe, root)
    const buf = Buffer.from(content, 'utf8')
    // Loop over short writes (see the async twin), then truncate to length.
    let off = 0
    while (off < buf.length) {
      const bytesWritten = nodeFs.writeSync(fd, buf, off, buf.length - off, off)
      if (bytesWritten <= 0) break
      off += bytesWritten
    }
    nodeFs.ftruncateSync(fd, buf.length)
  } finally {
    nodeFs.closeSync(fd)
  }
}

/**
 * Reads one directory's entries. Returns `null` (caller skips the directory)
 * for `EACCES`/`ENOENT`/`ENOTDIR` — a directory can disappear or become
 * unreadable between being queued and being walked. Any other error is
 * rethrown.
 */
async function readDirEntriesSafe(dir: string): Promise<import('node:fs').Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
}

/**
 * Classifies one readdir entry: a non-`SKIP_DIRS` directory is queued for
 * walking; a plain file is recorded as a `safeRoot`-relative POSIX path.
 * Skipped directories and non-file/non-directory entries (symlinks, sockets,
 * etc.) are a no-op.
 */
function collectListEntry(
  entry: import('node:fs').Dirent,
  dir: string,
  safeRoot: string,
  out: string[],
  queue: string[],
): void {
  const full = path.join(dir, entry.name)
  if (entry.isDirectory()) {
    if (!SKIP_DIRS.has(entry.name)) queue.push(full)
    return
  }
  if (entry.isFile()) {
    out.push(path.relative(safeRoot, full).split(path.sep).join('/'))
  }
}

async function listFiles(root: string, rootArg: string): Promise<string[]> {
  const safeRoot = await resolveWithinProjectRoot(rootArg, root)
  const out: string[] = []
  const queue: string[] = [safeRoot]
  while (queue.length > 0) {
    if (out.length >= LIST_FILE_LIMIT) break
    const dir = queue.shift()!
    const entries = await readDirEntriesSafe(dir)
    if (entries === null) continue
    for (const entry of entries) {
      if (out.length >= LIST_FILE_LIMIT) break
      collectListEntry(entry, dir, safeRoot, out, queue)
    }
  }
  return out
}

/**
 * Register the project-fs IPC channels. Call once during workbench setup;
 * the returned Disposable removes every channel (park on `ctx.registry`).
 */
export function registerProjectFsIpc(
  ctx: Pick<WorkbenchContext, 'workspace' | 'senderPolicy'>,
): Disposable {
  const getRoot = () => ctx.workspace.getProjectPath()
  const getLastClosedRoot = () => ctx.workspace.getLastClosedProjectPath()
  return new IpcRegistry(ctx.senderPolicy)
    .handle(ProjectFsChannel.GetRoot, () => getRoot())
    .handle(ProjectFsChannel.ReadFile, (_event, ...args: unknown[]) => {
      const [p] = validate(ProjectFsChannel.ReadFile, ReadFileSchema, args)
      // Reads stay scoped to the CURRENT root only — never widen the read
      // surface to the last-closed project.
      return readFile(getRoot(), p)
    })
    .handle(ProjectFsChannel.WriteFile, (_event, ...args: unknown[]) => {
      const [p, content] = validate(ProjectFsChannel.WriteFile, WriteFileSchema, args)
      // Accept a write under the current OR the just-closed project root (the
      // latter rescues an in-flight teardown flush after `closeProject`). The
      // selected root then runs the FULL sandbox (realpath containment +
      // ancestor guard + O_NOFOLLOW) inside `writeFile`, so the boundary is
      // never relaxed — only WHICH root is considered.
      const root = pickWriteRoot(p, { current: getRoot(), lastClosed: getLastClosedRoot() })
      return writeFile(root, p, content)
    })
    .handleSync(ProjectFsChannel.WriteFileSync, (_event, ...args: unknown[]) => {
      // Synchronous twin of WriteFile for the editor's beforeunload flush. Same
      // root selection + same sandbox (`writeFileSync` mirrors `writeFile`); the
      // only difference is the blocking transport. Returns `{ ok: true }`; any
      // throw is converted to `{ ok: false, code, message }` by `handleSync`.
      const [p, content] = validate(ProjectFsChannel.WriteFileSync, WriteFileSchema, args)
      const root = pickWriteRoot(p, { current: getRoot(), lastClosed: getLastClosedRoot() })
      writeFileSync(root, p, content)
      return { ok: true }
    })
    .handle(ProjectFsChannel.ListFiles, (_event, ...args: unknown[]) => {
      const [p] = validate(ProjectFsChannel.ListFiles, ListFilesSchema, args)
      return listFiles(getRoot(), p)
    })
}

/** Test seams — pure handlers, no Electron needed. */
export const __testing = { readFile, writeFile, writeFileSync, listFiles, pickWriteRoot, SKIP_DIRS, LIST_FILE_LIMIT }
