/**
 * Nothing reachable from the `./main` entry may import a VALUE from `electron`.
 *
 * Consumers mock electron in their unit tests, and a `vi.mock('electron',
 * factory)` whose factory transitively imports this entry deadlocks if loading
 * the entry needs `electron` back: the run hangs at import, where neither the
 * test nor the hook timeout applies, so it shows up as a test suite that never
 * finishes rather than as a failure. Type-only imports erase before runtime and
 * are fine; a module that genuinely needs `ipcMain` or `BrowserWindow` takes it
 * from its caller (see ipc-mux.ts).
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Every specifier `source` loads, with the clause text that pulls it in.
 *
 * Side-effect (`import 'x'`), dynamic (`import('x')`) and `require('x')` forms
 * carry no clause: none of them erase, so all three count as value imports.
 */
function importClauses(source: string): Array<{ clause: string; specifier: string }> {
  const clauses: Array<{ clause: string; specifier: string }> = []
  const fromClause = /(?:^|\n)\s*(?:import|export)([\s\S]*?)from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(fromClause)) {
    clauses.push({ clause: match[1]!, specifier: match[2]! })
  }
  const sideEffect = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  const called = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const pattern of [sideEffect, called]) {
    for (const match of source.matchAll(pattern)) {
      clauses.push({ clause: '', specifier: match[1]! })
    }
  }
  return clauses
}

/** True when the clause survives compilation — i.e. it is not type-only. */
function isValueImport(clause: string): boolean {
  const body = clause.trim()
  if (body.startsWith('type ')) return false
  const named = body.match(/^\{([\s\S]*)\}$/)
  if (!named) return true
  return named[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => !s.startsWith('type '))
}

/** The source file a relative specifier names, or null when there is none. */
function resolveSource(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier)
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, `${base}/index.ts`]
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null
}

/** Files reachable from `entry` through relative imports, entry included. */
function reachableFrom(entry: string): { files: Map<string, string>; unresolved: string[] } {
  const files = new Map<string, string>()
  const unresolved: string[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    const source = readFileSync(file, 'utf8')
    files.set(file, source)
    for (const { specifier } of importClauses(source)) {
      if (!specifier.startsWith('.')) continue
      const target = resolveSource(file, specifier)
      if (target) queue.push(target)
      else unresolved.push(`${file} → ${specifier}`)
    }
  }
  return { files, unresolved }
}

describe('the ./main entry', () => {
  const graph = reachableFrom(resolve(here, 'index.ts'))

  it('imports no value from electron, anywhere in its module graph', () => {
    const offenders: string[] = []
    for (const [file, source] of graph.files) {
      for (const { clause, specifier } of importClauses(source)) {
        if (specifier === 'electron' && isValueImport(clause)) {
          offenders.push(file.slice(file.indexOf('/src/') + 1))
        }
      }
    }
    expect(
      offenders,
      'a value import of electron here hangs any consumer test that mocks electron with a factory reaching this entry',
    ).toEqual([])
  })

  it('has every relative import resolvable, so the walk covers the whole graph', () => {
    expect(
      graph.unresolved,
      'an import this walk cannot follow is a blind spot: teach resolveSource about it',
    ).toEqual([])
  })
})
