/**
 * Inject the dd/wx ambient typings into the embedded editor's TS project using
 * the official `@types`/typeRoots convention (orta, microsoft/vscode#172887).
 *
 * The web tsserver only reads files INSIDE the workspace root, and there is no
 * API to push ambient text into the running server (its VFS must be
 * pre-populated; see microsoft/TypeScript#47600). So the typings are written as
 * REAL files in the memfs workspace under `node_modules/@types/<name>/` — the
 * place TS module resolution looks for ambient packages automatically. The
 * flusher (file-workspace) never writes `node_modules/` back to disk, so the
 * user's project on disk is untouched.
 *
 * How the program picks them up (verified on monaco-vscode-api@34 web tsserver):
 *  - No config OR a `jsconfig.json`: the inferred `.js` project auto-includes
 *    every `node_modules/@types/*` package — nothing else is needed.
 *  - A user `tsconfig.json`: `@types` are NOT auto-picked up for `.js` files, so
 *    each injected package name is appended to `compilerOptions.types` in the
 *    MEMFS copy only (the on-disk tsconfig is never modified). If the user set
 *    `types: []` deliberately we still append our names — without that the
 *    injected tooling would silently do nothing.
 */
import type { IFileService } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'
import { WORKSPACE_FILE_ROOT, TYPES_ROOT } from './file-workspace'
import { DIMINA_DTS } from './dimina-dts'

/** `@types` package name for the built-in dd/wx ambient typings. */
export const DIMINA_TYPES_NAME = 'dimina'

/** An extra ambient typings package to inject, e.g. from a downstream `/__contrib` extension. */
export interface ExtraTyping {
  /** `@types` package name (sanitized, collision-free), e.g. `qdmp-editor`. */
  name: string
  /** Concatenated `.d.ts` source for the package's `index.d.ts`. */
  content: string
}

function wsUri(rel: string): URI {
  return URI.parse(`${WORKSPACE_FILE_ROOT}/${rel}`)
}

async function exists(fileService: IFileService, rel: string): Promise<boolean> {
  try {
    return await fileService.exists(wsUri(rel))
  } catch {
    return false
  }
}

async function readJsonc(fileService: IFileService, rel: string): Promise<Record<string, unknown> | null> {
  try {
    const buf = await fileService.readFile(wsUri(rel))
    return parseJsonc(buf.value.toString())
  } catch {
    return null
  }
}

/** Tolerant JSON: strips line/block comments + trailing commas before parse. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    // fall through to a lenient pass
  }
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(stripped) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Write one `@types/<name>/{package.json,index.d.ts}` ambient package into memfs. */
async function writeTypesPackage(fileService: IFileService, name: string, dts: string): Promise<void> {
  const pkg = JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' })
  await fileService.writeFile(wsUri(`${TYPES_ROOT}/${name}/package.json`), VSBuffer.fromString(pkg))
  await fileService.writeFile(wsUri(`${TYPES_ROOT}/${name}/index.d.ts`), VSBuffer.fromString(dts))
}

/**
 * Ensure `compilerOptions.types` contains every name in `names` (dedup, preserve
 * order). Returns the config object (mutated) — callers serialize + write it.
 */
export function ensureTypesInclude(config: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const co = (config.compilerOptions as Record<string, unknown> | undefined) ?? {}
  const current = Array.isArray(co.types) ? (co.types as unknown[]).map(String) : []
  const merged = [...current]
  for (const name of names) {
    if (!merged.includes(name)) merged.push(name)
  }
  co.types = merged
  config.compilerOptions = co
  return config
}

/**
 * Write the dd/wx ambient typings (+ any downstream extras) into the memfs
 * workspace as `@types` packages and make the project's TS program see them.
 * Best-effort: any failure is the caller's to log; it never throws past here.
 */
export async function seedAmbientTypings(
  fileService: IFileService,
  extras: ExtraTyping[] = [],
): Promise<void> {
  // 1. Write the built-in + contributed typings as @types packages.
  await writeTypesPackage(fileService, DIMINA_TYPES_NAME, DIMINA_DTS)
  for (const extra of extras) {
    await writeTypesPackage(fileService, extra.name, extra.content)
  }

  const typeNames = [DIMINA_TYPES_NAME, ...extras.map((e) => e.name)]

  // 2. A user tsconfig does not auto-include @types for `.js`, so append our
  //    package names to its `compilerOptions.types` (memfs copy only). A user
  //    jsconfig (or no config) auto-includes @types, so nothing else is needed
  //    there — but if a jsconfig exists, merging the same names is harmless and
  //    keeps the behavior explicit.
  for (const configRel of ['tsconfig.json', 'jsconfig.json']) {
    if (await exists(fileService, configRel)) {
      const config = (await readJsonc(fileService, configRel)) ?? {}
      ensureTypesInclude(config, typeNames)
      await fileService.writeFile(wsUri(configRel), VSBuffer.fromString(JSON.stringify(config, null, 2)))
      return
    }
  }
  // No config: the inferred `.js` project auto-includes @types — leave it be so
  // the only injected artifact is the hidden `node_modules/@types/` folder.
}
