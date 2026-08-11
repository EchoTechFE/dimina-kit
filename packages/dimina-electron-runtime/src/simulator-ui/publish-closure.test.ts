/**
 * The `simulator-ui` subpath ships compiled output, so `tsc` is what guarantees
 * every `.ts`/`.tsx` the entry reaches ends up in `dist`. Stylesheets are the
 * hole in that guarantee: the components import them for their side effect and
 * `tsc` keeps the import in the emitted JavaScript while copying nothing, so a
 * separate script (build-simulator-ui-css.mjs) carries them over — and it reads
 * one flat directory. A stylesheet added in a subdirectory would compile,
 * publish, and then fail to resolve in a consumer's bundler.
 *
 * This walks the real import graph from the entry and asserts the shape the
 * copy step can actually cover, plus that the manifest exports compiled output
 * rather than implementation source.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '../..')
const ENTRY = join(HERE, 'index.ts')

function candidatePaths(base: string): string[] {
  // Relative specifiers spell the EMITTED `.js` while the file on disk is
  // `.ts`/`.tsx`; a stylesheet is imported with its own extension.
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -'.js'.length)
    return [`${stem}.ts`, `${stem}.tsx`, base]
  }
  return [base]
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
 * `import '...'`, and dynamic `import('...')`. A dynamic import reaches a file
 * at runtime just as a static one does.
 *
 * A specifier written inside a comment counts too. That direction is safe: it
 * can only add a file to the closure, and the failure names the specifier.
 * Missing a real import would instead pass while the tarball is broken.
 */
function relativeSpecifiers(source: string): string[] {
  const found = new Set<string>()
  const patterns = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
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
  exports: Record<string, { types: string, default: string }>
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
  const subpath = manifest.exports['./simulator-ui']!

  it('exports compiled output, so a consumer never compiles this implementation', () => {
    expect(subpath.types).toMatch(/^\.\/dist\//)
    expect(subpath.default).toMatch(/^\.\/dist\//)
  })

  it('publishes the compiled entry and keeps the source out of the tarball', () => {
    expect(isPublished(manifest.files, 'dist/simulator-ui/index.js')).toBe(true)
    expect(isPublished(manifest.files, 'dist/simulator-ui/index.d.ts')).toBe(true)
    expect(isPublished(manifest.files, 'dist/simulator-ui/miniapp-frame.css')).toBe(true)
    expect(isPublished(manifest.files, 'src/simulator-ui/miniapp-frame.tsx')).toBe(false)
  })

  it('keeps every stylesheet where the copy step looks for it', () => {
    const stylesheets = importClosure(ENTRY).filter(file => file.endsWith('.css'))

    // Not an incidental assertion: an empty result would make this vacuous, and
    // the components do import their stylesheets.
    expect(stylesheets.length).toBeGreaterThan(0)
    for (const stylesheet of stylesheets) {
      expect(dirname(stylesheet), `${stylesheet} is outside the copied directory`).toBe(HERE)
    }
  })

  it('reads files patterns as POSIX only, which is what the closure normalises for', () => {
    expect(isPublished(manifest.files, 'dist\\simulator-ui\\index.js')).toBe(false)
    expect(isPublished(manifest.files, 'dist/simulator-ui/index.js')).toBe(true)
  })

  it('keeps declaration maps out of the tarball while keeping declarations in', () => {
    expect(isPublished(manifest.files, 'dist/simulator-ui/index.d.ts.map')).toBe(false)
    expect(isPublished(manifest.files, 'dist/simulator-ui/index.d.ts')).toBe(true)
  })
})

/**
 * `relative`/`sep` are the POSIX normalisation the manifest patterns assume.
 * Kept as an explicit check so the helper above is exercised on this platform.
 */
describe('package-relative paths', () => {
  it('normalises to POSIX separators', () => {
    const posix = relative(PACKAGE_ROOT, ENTRY).split(sep).join('/')
    expect(posix).toBe('src/simulator-ui/index.ts')
  })
})
