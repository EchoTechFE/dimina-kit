import { describe, expect, it } from 'vitest'
import { DERIVED_PREFIXES, normalizePath } from './paths.js'

describe('normalizePath', () => {
  it('strips a leading "./" and collapses internal "."/empty segments', () => {
    expect(normalizePath('./a/./b')).toBe('a/b')
    expect(normalizePath('a//b')).toBe('a/b')
  })

  it('rejects absolute paths', () => {
    expect(normalizePath('/a/b')).toBeNull()
  })

  it('rejects paths that escape via ".."', () => {
    expect(normalizePath('a/../../b')).toBeNull()
  })

  it('rejects non-string, empty, NUL, and backslash input', () => {
    expect(normalizePath(undefined)).toBeNull()
    expect(normalizePath(42)).toBeNull()
    expect(normalizePath('')).toBeNull()
    expect(normalizePath('a\0b')).toBeNull()
    expect(normalizePath('a\\b')).toBeNull()
  })

  it('returns null for a path that normalizes to nothing (all "." segments)', () => {
    expect(normalizePath('./.')).toBeNull()
  })

  it('leaves an already-clean relative path untouched', () => {
    expect(normalizePath('a/b/c.txt')).toBe('a/b/c.txt')
  })
})

describe('DERIVED_PREFIXES', () => {
  it('lists the derived-area prefixes checkWrite rejects', () => {
    expect(DERIVED_PREFIXES).toEqual(['node_modules/', '.checkpoints/'])
  })
})
