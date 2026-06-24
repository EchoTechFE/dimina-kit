/**
 * Downstream editor extensibility: load host-contributed VS Code web extensions
 * into the workbench ext-host at boot.
 *
 * The framework's COI server serves a host-provided extensions directory under
 * `/__contrib/` and a `/__contrib/index.json` manifest listing each extension
 * (its `package.json` + file list). This registers every contributed extension
 * as a system web extension (LocalWebWorker) and wires its files to the
 * same-origin `/__contrib/<dir>/<file>` URLs, so a host (or qdmp) can add
 * languages, commands, and views to the editor without forking the bundle.
 *
 * Best-effort: a missing manifest (no extensionsDir configured), a failed
 * fetch, or one broken extension never blocks workbench boot.
 */
import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions'
import type { ExtraTyping } from './typings-injection'

interface ContributedExtension {
  dir: string
  packageJson: {
    name?: string
    publisher?: string
    /** Framework contribution: ambient `.d.ts` paths to inject into the editor's TS project. */
    diminaWorkbench?: { typings?: string[] }
  } & Record<string, unknown>
  files: string[]
}

/** What {@link registerContributedExtensions} found: registered count + collected typings. */
export interface ContributedExtensionsResult {
  count: number
  typings: ExtraTyping[]
}

const MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function mimeFor(file: string): string {
  const i = file.lastIndexOf('.')
  return (i >= 0 && MIME_BY_EXT[file.slice(i)]) || 'application/octet-stream'
}

/**
 * Fetch the contribution manifest and register each extension. Returns the count
 * registered. Resolves 0 (never throws) when nothing is contributed or on error.
 */
export async function registerContributedExtensions(): Promise<ContributedExtensionsResult> {
  let list: ContributedExtension[]
  try {
    const res = await fetch('/__contrib/index.json')
    if (!res.ok) return { count: 0, typings: [] }
    list = (await res.json()) as ContributedExtension[]
  } catch {
    return { count: 0, typings: [] }
  }
  let count = 0
  const typings: ExtraTyping[] = []
  for (const ext of list) {
    try {
      const reg = registerExtension(ext.packageJson as never, ExtensionHostKind.LocalWebWorker, { system: true })
      if ('registerFileUrl' in reg) {
        for (const file of ext.files) {
          // package.json is consumed by registerExtension itself, not as a file.
          if (file === 'package.json') continue
          // Absolute, same-origin URL — the worker ext-host fetches the entry and
          // a root-relative path would resolve against the wrong base there.
          const url = new URL(`/__contrib/${ext.dir}/${file}`, location.origin).toString()
          reg.registerFileUrl('./' + file, url, { mimeType: mimeFor(file) })
        }
      }
      await reg.whenReady()
      count++
      typings.push(...(await collectTypings(ext)))
    } catch (e) {
      console.error('[a2-workbench] contributed extension failed:', ext.dir, e)
    }
  }
  return { count, typings }
}

/** Map an extension dir to a safe `@types` package name (no path separators / dots). */
function typesPackageName(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9_-]/g, '-')
}

/**
 * Collect a contributed extension's declared ambient typings into a single
 * `@types/<name>` package. Each path in `package.json#diminaWorkbench.typings`
 * MUST be one of the extension's own `files` (rejects path traversal / reads of
 * unrelated COI files) and is fetched from its same-origin `/__contrib` URL. The
 * declared `.d.ts` sources are concatenated into one package's `index.d.ts`,
 * named after the extension dir so two extensions cannot collide. Returns at
 * most one ExtraTyping per extension (empty when nothing valid was declared).
 */
async function collectTypings(ext: ContributedExtension): Promise<ExtraTyping[]> {
  const declared = ext.packageJson.diminaWorkbench?.typings
  if (!Array.isArray(declared) || declared.length === 0) return []
  const parts: string[] = []
  for (const p of declared) {
    if (typeof p !== 'string' || !ext.files.includes(p)) {
      console.error('[a2-workbench] ignoring typings path not in ext files:', ext.dir, p)
      continue
    }
    try {
      const res = await fetch(new URL(`/__contrib/${ext.dir}/${p}`, location.origin).toString())
      if (!res.ok) continue
      parts.push(await res.text())
    } catch (e) {
      console.error('[a2-workbench] failed to fetch contributed typing:', ext.dir, p, e)
    }
  }
  if (parts.length === 0) return []
  return [{ name: typesPackageName(ext.dir), content: parts.join('\n') }]
}
