/**
 * Pure `/__fs` bridge calls + workspace-URI helpers: talk only to the COI
 * server's `/__fs/*` endpoints over `fetch`, no monaco/vscode dependency.
 * Kept separate from file-workspace.ts (which wires these into the monaco
 * file service) so a consumer that only needs the bridge itself — the WAL
 * audit decorator, or a unit test — never pulls in the full
 * monaco-vscode-api runtime (its internal CSS assets are unresolvable outside
 * a browser/Vite-transformed environment).
 */

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

export type FsEntry = [string, number] // [name, type] — 1 file, 2 dir

export async function bridgeReaddir(baseUrl: string, rel: string): Promise<FsEntry[]> {
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

export async function bridgeRead(baseUrl: string, rel: string): Promise<Uint8Array> {
  const u = new URL(`${baseUrl}__fs/read`)
  u.searchParams.set('p', rel)
  const res = await fetch(u.toString())
  if (!res.ok) throw new Error(`read ${rel}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function bridgeWrite(baseUrl: string, rel: string, content: Uint8Array): Promise<void> {
  const u = new URL(`${baseUrl}__fs/write`)
  u.searchParams.set('p', rel)
  const res = await fetch(u.toString(), { method: 'POST', body: content.slice() })
  if (!res.ok) throw new Error(`write ${rel}: ${res.status}`)
}

/** Delete twin of {@link bridgeWrite} — used by the WAL audit decorator to replay an agent `rm` or a rollback onto disk. */
export async function bridgeDelete(baseUrl: string, rel: string): Promise<void> {
  const u = new URL(`${baseUrl}__fs/delete`)
  u.searchParams.set('p', rel)
  const res = await fetch(u.toString(), { method: 'POST' })
  if (!res.ok) throw new Error(`delete ${rel}: ${res.status}`)
}

/** Structural URI shape (just `.toString()`) so callers don't need the real monaco `URI` class to use {@link relFromWorkspaceUri}. */
export interface WorkspaceUriLike {
  toString(): string
}

/**
 * Resolve a `file:///workspace/<rel>` URI to its project-relative bridge path,
 * or `null` when it falls outside {@link WORKSPACE_FILE_ROOT} or names
 * devtools-injected tooling that must never round-trip to disk: the injected
 * `@types` packages live under memfs-only `node_modules/`, and a user
 * tsconfig/jsconfig we merged the typings names into must keep its on-disk
 * copy untouched — the merge lives only in the memfs mirror. Shared by
 * `flushFileWorkspaceSaveToDisk` and the WAL audit decorator so both agree on
 * which saves are disk-backed.
 */
export function relFromWorkspaceUri(uri: WorkspaceUriLike): string | null {
  const prefix = WORKSPACE_FILE_ROOT + '/'
  const full = uri.toString()
  if (!full.startsWith(prefix)) return null
  const rel = decodeURIComponent(full.slice(prefix.length))
  if (rel === 'node_modules/' || rel.startsWith('node_modules/')) return null
  if (rel === 'jsconfig.json' || rel === 'tsconfig.json') return null
  return rel
}
