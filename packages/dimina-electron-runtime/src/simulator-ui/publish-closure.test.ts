/**
 * The `simulator-ui` subpath export points at TypeScript source, not `dist`,
 * because a bundler consumes it. That makes the published tarball responsible
 * for carrying every file the entry transitively reaches by a relative import —
 * including the ones outside `src/simulator-ui`, which `files` has to name one
 * by one. A consumer installing the package resolves those imports against the
 * tarball, so a file left out is an unresolvable import at their build time,
 * invisible from inside this workspace where the file still exists.
 *
 * This walks the real import graph from the entry and asserts `files` covers
 * all of it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '../..')
const ENTRY = join(HERE, 'index.ts')

/**
 * Extensionless bundler specifiers resolve through these, in order. A
 * stylesheet is always imported with its `.css` spelled out, so the empty
 * suffix already covers it — guessing `.css` for an extensionless specifier
 * would accept an import Vite itself does not resolve.
 */
const RESOLUTION_ORDER = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function candidatePaths(base: string): string[] {
  // `src/shared` is Node16 ESM, where a relative import spells the EMITTED
  // `.js` while the file on disk is `.ts`.
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -'.js'.length)
    return [`${stem}.ts`, `${stem}.tsx`, base]
  }
  return RESOLUTION_ORDER.map(suffix => base + suffix)
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of candidatePaths(base)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Every relative specifier in a source file: `from '...'`, bare side-effect
 * `import '...'`, dynamic `import('...')`, and `/// <reference path="...">`.
 * A dynamic import reaches a file at runtime just as a static one does, and a
 * reference directive pulls a declaration file into the consumer's program, so
 * leaving either out would let an unpublished file through.
 *
 * A specifier written inside a comment counts too. That direction is safe: it
 * can only add a file to the closure, so at worst this asks `files` to publish
 * something already on disk, and the failure names the specifier. Missing a
 * real import would instead pass while the tarball is broken.
 */
function relativeSpecifiers(source: string): string[] {
  const found = new Set<string>()
  const patterns = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\/\/\/\s*<reference\s+path\s*=\s*['"](\.[^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]!)
  }
  return [...found]
}

function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (file.endsWith('.css')) continue
    for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
      const resolved = resolveSpecifier(file, specifier)
      // An unresolvable relative import is itself a defect, so surface the
      // specifier rather than silently dropping it from the closure.
      expect(resolved, `unresolvable import ${specifier} in ${file}`).not.toBeNull()
      queue.push(resolved!)
    }
  }
  return [...seen]
}

interface PackageManifest {
  files: string[]
}

const GLOB_TOKEN = /\/\*\*\/|\*\*|\*|[.+^${}()|[\]\\]/g

/**
 * A `files` glob as a regex. One pass over the pattern, so a replacement can
 * never be re-read as glob syntax: `/` + `**` + `/` spans zero or more
 * directories, a bare double star any characters, a single star anything
 * inside one path segment, and everything else regex-special is escaped.
 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(GLOB_TOKEN, (token) => {
    if (token === '/**/') return '/(?:.*/)?'
    if (token === '**') return '.*'
    if (token === '*') return '[^/]*'
    return `\\${token}`
  })
  return new RegExp(`^${source}$`)
}

/**
 * Whether `files` publishes a path. npm treats a bare directory entry as the
 * whole subtree and applies `!` entries as exclusions, both of which this
 * mirrors for the entry shapes this package actually uses. Later entries win.
 */
function isPublished(manifestFiles: string[], packageRelativePath: string): boolean {
  let published = false
  for (const entry of manifestFiles) {
    const negated = entry.startsWith('!')
    const pattern = negated ? entry.slice(1) : entry
    if (pattern.includes('*')) {
      if (globToRegExp(pattern).test(packageRelativePath)) published = !negated
      continue
    }
    if (packageRelativePath === pattern || packageRelativePath.startsWith(`${pattern}/`)) {
      published = !negated
    }
  }
  return published
}

describe('simulator-ui publish closure', () => {
  const manifest = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as PackageManifest

  it('publishes every file the entry reaches by a relative import', () => {
    const missing = importClosure(ENTRY)
      // `files` patterns are POSIX-style whatever the host platform is.
      .map(file => relative(PACKAGE_ROOT, file).split(sep).join('/'))
      .filter(packageRelativePath => !isPublished(manifest.files, packageRelativePath))
      .sort()

    expect(missing).toEqual([])
  })

  it('reaches the ambient declarations through the entry reference directives', () => {
    const closure = importClosure(ENTRY).map(file => relative(PACKAGE_ROOT, file).split(sep).join('/'))

    for (const declaration of ['src/simulator-ui/css.d.ts', 'src/simulator-ui/webview.d.ts']) {
      expect(closure).toContain(declaration)
      expect(isPublished(manifest.files, declaration)).toBe(true)
    }
  })

  it('reads files patterns as POSIX only, which is what the closure normalises for', () => {
    expect(isPublished(manifest.files, 'src\\simulator-ui\\index.ts')).toBe(false)
    expect(isPublished(manifest.files, 'src/simulator-ui/index.ts')).toBe(true)
  })

  it('keeps test files out of the tarball while keeping their subjects in', () => {
    expect(isPublished(manifest.files, 'src/simulator-ui/tab-bar.test.tsx')).toBe(false)
    expect(isPublished(manifest.files, 'src/simulator-ui/tab-bar.tsx')).toBe(true)
  })

  it('keeps test fixtures out of the tarball', () => {
    // A fixture is not named `*.test.*`, so the exclusion above does not catch
    // it — and it imports devDependencies, which a consumer cannot resolve.
    expect(
      isPublished(manifest.files, 'src/simulator-ui/__test-stubs__/miniapp-frame-harness.tsx'),
    ).toBe(false)
  })
})
