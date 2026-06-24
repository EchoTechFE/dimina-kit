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

interface ContributedExtension {
  dir: string
  packageJson: { name?: string; publisher?: string } & Record<string, unknown>
  files: string[]
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
export async function registerContributedExtensions(): Promise<number> {
  let list: ContributedExtension[]
  try {
    const res = await fetch('/__contrib/index.json')
    if (!res.ok) return 0
    list = (await res.json()) as ContributedExtension[]
  } catch {
    return 0
  }
  let count = 0
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
    } catch (e) {
      console.error('[a2-workbench] contributed extension failed:', ext.dir, e)
    }
  }
  return count
}
