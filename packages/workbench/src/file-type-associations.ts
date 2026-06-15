/**
 * `files.associations` for the embedded editor: map mini-program source files to
 * the language that highlights them. The built-in `wx*` extensions plus any
 * host-configured custom file types (e.g. `.qdml`/`.qdss`/`.qds`).
 *
 * `.wxml` is owned by the `wxml` language extension's own `extensions` array
 * (see boot.ts); the rest ride on `files.associations`, which routes a glob to
 * an already-registered language id (`css`/`javascript`/`wxml`).
 */

/**
 * Custom mini-program file types. Same shape as the dmcc compiler's `build()`
 * `options.fileTypes` and the devtools host's `CustomFileTypes`, so the editor
 * and the build agree on which extensions are valid. `template` highlights as
 * wxml, `style` as css, `viewScript` as javascript.
 */
export interface CustomFileTypes {
  template?: string[]
  style?: string[]
  viewScript?: string[]
}

/**
 * Built-in associations always present. `.wxss`→css and `.wxs`→javascript (no
 * dedicated wxss/wxs grammar is bundled; css/js are close). `.wxml` is omitted —
 * it is contributed by the wxml language extension, not by association.
 */
export const BUILTIN_FILE_ASSOCIATIONS: Readonly<Record<string, string>> = {
  '*.wxss': 'css',
  '*.wxs': 'javascript',
}

/**
 * Extensions already owned by a built-in language/grammar. A custom file type
 * must not silently reclassify a known source file, so these are skipped.
 */
const BUILTIN_EXTS: ReadonlySet<string> = new Set([
  'wxml', 'wxss', 'wxs',
  'json', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'css', 'less', 'scss', 'html', 'htm', 'md', 'markdown',
])

/**
 * Normalize one item to a bare extension (no dot): trim, lowercase, strip
 * leading dots. Accepts only `[a-z0-9_-]` — the same rule as the dmcc compiler's
 * `normalizeExt`, so the editor and the build agree on which extensions are
 * valid (no "highlighted but not compiled" divergence). Empty / path-bearing /
 * metachar items → null.
 */
function normalizeExt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase().replace(/^\.+/, '')
  if (!/^[a-z0-9_-]+$/.test(v)) return null
  return v
}

/**
 * Build the `files.associations` map for the editor: the built-ins plus the
 * host's custom file types. Custom extensions that collide with a built-in are
 * skipped (a brand type must not reclassify `.js`/`.wxml`/...). The returned
 * map is a fresh object each call (no leak across projects).
 */
export function buildFileAssociations(fileTypes?: CustomFileTypes): Record<string, string> {
  const out: Record<string, string> = { ...BUILTIN_FILE_ASSOCIATIONS }
  const add = (exts: string[] | undefined, lang: string): void => {
    for (const raw of exts ?? []) {
      const ext = normalizeExt(raw)
      if (ext && !BUILTIN_EXTS.has(ext)) out[`*.${ext}`] = lang
    }
  }
  add(fileTypes?.template, 'wxml')
  add(fileTypes?.style, 'css')
  add(fileTypes?.viewScript, 'javascript')
  return out
}
