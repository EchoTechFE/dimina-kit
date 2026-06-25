/**
 * Mirror the on-disk dimina project into the workbench's default `file://`
 * in-memory filesystem and keep saves flushed back to disk.
 *
 * Why `file://` (not the `diminafs:` provider directly): the web tsserver only
 * treats a `file://` root as a real TS/JS project — it loads jsconfig.json and
 * ambient `.d.ts` files from there. Over a custom scheme it falls back to an
 * inferred project that ignores workspace config + ambient libs, so `dd`
 * resolves to `any`. Mirroring under `file:///workspace/` gives tsserver a real
 * project root; a save listener flushes edits back to disk via the fs bridge so
 * editing stays real (round-trips to the actual project).
 *
 * The disk source is read through the same COI `/__fs/*` bridge the diminafs
 * provider uses, so no extra preload/IPC surface.
 */
import { getService, IFileService } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'

export const WORKSPACE_FILE_ROOT = 'file:///workspace'

/**
 * In-workspace `@types` root holding all devtools-injected ambient typings. TS
 * module resolution auto-discovers `node_modules/@types/*`, so the dd/wx (and
 * contributed) packages land here. Lives under the workspace root (the web
 * tsserver only reads inside it), kept out of the Explorer via `files.exclude`,
 * and never flushed back to disk. dimina projects have no real `node_modules` at
 * the editor root, so reusing that path is safe.
 */
export const TYPES_ROOT = 'node_modules/@types'

type FsEntry = [string, number] // [name, type] — 1 file, 2 dir

async function bridgeReaddir(baseUrl: string, rel: string): Promise<FsEntry[]> {
  const u = new URL(`${baseUrl}__fs/readdir`)
  u.searchParams.set('p', rel)
  const res = await fetch(u.toString())
  // 409 = no active project yet (ENOACTIVE). Treat as an empty tree rather than
  // throwing: the workbench may attach before a project is open, and erroring
  // would spew uncaught failures + leave file:///workspace unresolvable.
  if (res.status === 409) return []
  if (!res.ok) throw new Error(`readdir ${rel}: ${res.status}`)
  return (await res.json()) as FsEntry[]
}

async function bridgeRead(baseUrl: string, rel: string): Promise<Uint8Array> {
  const u = new URL(`${baseUrl}__fs/read`)
  u.searchParams.set('p', rel)
  const res = await fetch(u.toString())
  if (!res.ok) throw new Error(`read ${rel}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function bridgeWrite(baseUrl: string, rel: string, content: Uint8Array): Promise<void> {
  const u = new URL(`${baseUrl}__fs/write`)
  u.searchParams.set('p', rel)
  const res = await fetch(u.toString(), { method: 'POST', body: content.slice() })
  if (!res.ok) throw new Error(`write ${rel}: ${res.status}`)
}

/**
 * Recursively copy disk (via the fs bridge) → file:///workspace/ memfs.
 * Returns the number of files mirrored.
 */
export async function mirrorDiskToFileWorkspace(baseUrl: string): Promise<number> {
  const fileService = await getService(IFileService)
  let count = 0

  async function walk(rel: string): Promise<void> {
    const entries = await bridgeReaddir(baseUrl, rel || '.')
    for (const [name, type] of entries) {
      const childRel = rel ? `${rel}/${name}` : name
      if (type === 2) {
        await walk(childRel)
      } else {
        const bytes = await bridgeRead(baseUrl, childRel)
        await fileService.writeFile(URI.parse(`${WORKSPACE_FILE_ROOT}/${childRel}`), VSBuffer.wrap(bytes))
        count++
      }
    }
  }

  // The workbench attaches as soon as the 'editor' dock slot first paints, which
  // can be a beat before the active project is set AND before its compile
  // finishes — until then the COI `/__fs` bridge returns an empty tree (409 → []).
  // Poll the project root until it has entries (project active), THEN mirror once.
  // ~30s budget covers a cold compile; a genuinely empty/no-project workspace
  // simply yields 0 after the wait (no error, no partial copy).
  let rootEntries: FsEntry[] = []
  for (let attempt = 0; attempt < 60; attempt++) {
    rootEntries = await bridgeReaddir(baseUrl, '.')
    if (rootEntries.length > 0) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (rootEntries.length === 0) return 0
  await walk('')
  return count
}

/**
 * Flush a file:///workspace/<rel> save back to disk through the fs bridge.
 * `uri` must be under WORKSPACE_FILE_ROOT.
 */
export async function flushFileWorkspaceSaveToDisk(baseUrl: string, uri: URI, content: Uint8Array): Promise<void> {
  const prefix = WORKSPACE_FILE_ROOT + '/'
  const full = uri.toString()
  if (!full.startsWith(prefix)) return
  const rel = decodeURIComponent(full.slice(prefix.length))
  // Never flush devtools-injected tooling back to disk: the injected `@types`
  // packages live under memfs-only `node_modules/`, and a user tsconfig/jsconfig
  // we merged the typings names into must keep its on-disk copy untouched — the
  // merge lives only in the memfs mirror.
  if (rel === 'node_modules/' || rel.startsWith('node_modules/')) return
  if (rel === 'jsconfig.json' || rel === 'tsconfig.json') return
  await bridgeWrite(baseUrl, rel, content)
}
