/**
 * Contract: the standalone Electron app (packaged via `electron-builder`,
 * config in `electron-builder.yml`) must ship the `templates/` directory.
 *
 * `packages/devtools/src/main/services/projects/builtin-templates.ts`
 * resolves every built-in template's `source.path` as
 * `path.join(devtoolsPackageRoot, 'templates', ...)` at runtime.
 * `package.json`'s `"files"` (npm publish manifest) already lists
 * `"templates"`, so `npm install`-based consumption is fine — but
 * `electron-builder.yml` has its own, separate `files:` allowlist for the
 * STANDALONE desktop app build. If that allowlist doesn't also include
 * `templates/`, a packaged app ships without its template sources and
 * "new project" breaks for end users running the packaged app, even though
 * the library package (and every unit test that exercises
 * `builtin-templates.ts` against the repo checkout) works fine.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const electronBuilderYmlPath = path.join(packageRoot, 'electron-builder.yml')

/**
 * Minimal line-based extraction of the top-level `files:` list entries.
 * No YAML parser is resolvable from this package's dependency tree
 * (`js-yaml` is only a transitive dependency of `electron-builder`, not
 * hoisted here), so this walks the raw text: find the `files:` key, collect
 * `- entry` lines until the next top-level (non-indented) key, and strip
 * quotes/inline comments.
 */
function extractFilesListEntries(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/)
  const filesKeyIndex = lines.findIndex((line) => /^files:\s*$/.test(line))
  if (filesKeyIndex === -1) {
    throw new Error('electron-builder.yml has no top-level `files:` key')
  }

  const entries: string[] = []
  for (let i = filesKeyIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\S/.test(line)) break // dedented back to a new top-level key
    const match = line.match(/^\s*-\s*(.+?)\s*$/)
    if (!match) continue
    let entry = match[1]!
    entry = entry.replace(/\s+#.*$/, '') // strip inline comment
    entry = entry.replace(/^['"]|['"]$/g, '') // strip surrounding quotes
    entries.push(entry)
  }
  return entries
}

describe('electron-builder.yml — standalone app ships built-in project templates', () => {
  it('includes the templates/ directory in the packaged-app files: allowlist', () => {
    const yamlText = fs.readFileSync(electronBuilderYmlPath, 'utf-8')
    const entries = extractFilesListEntries(yamlText)

    expect(entries.length).toBeGreaterThan(0)

    const templateInclusionEntry = entries.find((entry) => {
      if (entry.startsWith('!')) return false // exclusion, not inclusion
      const normalized = entry.replace(/\\/g, '/')
      return (
        normalized === 'templates' ||
        normalized === 'templates/**/*' ||
        normalized.startsWith('templates/')
      )
    })

    expect(
      templateInclusionEntry,
      `electron-builder.yml's files: allowlist (${JSON.stringify(
        entries,
      )}) has no entry for templates/ — a standalone-packaged app would be ` +
        `missing its built-in project templates (builtin-templates.ts ` +
        `resolves them at <packageRoot>/templates at runtime)`,
    ).toBeDefined()
  })
})
