import { describe, it, expect } from 'vitest'
import {
  buildSimulatorUrl,
  collapseHashToTopPage,
  extractCurrentPage,
} from './simulator-url'

describe('buildSimulatorUrl', () => {
  it('builds URL with appId and startPage', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/index/index',
      scene: 1001,
      queryParams: [],
    }, 9000)
    expect(url).toContain('http://localhost:9000/simulator.html#wx123|pages/index/index')
    expect(url).toContain('scene=1001')
  })

  it('uses default startPage when empty', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: '',
      scene: 1001,
      queryParams: [],
    }, 9000)
    expect(url).toContain('|pages/index/index')
  })

  it('includes query params', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/detail/detail',
      scene: 1002,
      queryParams: [
        { key: 'id', value: '42' },
        { key: 'from', value: 'home' },
      ],
    }, 9000)
    expect(url).toContain('id=42')
    expect(url).toContain('from=home')
    expect(url).toContain('scene=1002')
  })

  it('filters empty query param keys', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/index/index',
      scene: 1001,
      queryParams: [
        { key: '', value: 'ignored' },
        { key: 'valid', value: 'yes' },
      ],
    }, 9000)
    expect(url).not.toContain('ignored')
    expect(url).toContain('valid=yes')
  })
})

describe('extractCurrentPage', () => {
  it('extracts page path from hash', () => {
    const url = 'http://localhost:9000/#wx123/pages/index/index?scene=1001'
    expect(extractCurrentPage(url)).toBe('pages/index/index')
  })

  it('extracts nested path', () => {
    const url = 'http://localhost:9000/#wx123/subpackages/detail/detail'
    expect(extractCurrentPage(url)).toBe('subpackages/detail/detail')
  })

  it('returns empty string when no hash', () => {
    expect(extractCurrentPage('http://localhost:9000/')).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(extractCurrentPage('')).toBe('')
  })
})

describe('collapseHashToTopPage', () => {
  it('returns URL unchanged when hash has a single page (no stack)', () => {
    const url = 'http://localhost:9000/simulator.html#wx_app|pages/a/a?scene=1001'
    expect(collapseHashToTopPage(url)).toBe(url)
  })

  it('collapses a multi-page stack down to {appId}|{topPage} and preserves the query verbatim', () => {
    const input =
      'http://localhost:9000/simulator.html#wx_app|pages/a/a|pages/b/b?scene=1001&k=v'
    const expected =
      'http://localhost:9000/simulator.html#wx_app|pages/b/b?scene=1001&k=v'
    expect(collapseHashToTopPage(input)).toBe(expected)
  })

  it('collapses deeper stacks (>2 pages) to just the top page', () => {
    const input =
      'http://localhost:9000/simulator.html#wx_app|pages/a/a|pages/b/b|pages/c/c|pages/d/d?scene=1001'
    const expected =
      'http://localhost:9000/simulator.html#wx_app|pages/d/d?scene=1001'
    expect(collapseHashToTopPage(input)).toBe(expected)
  })

  it('returns URL unchanged when there is no hash at all', () => {
    const url = 'http://localhost:9000/simulator.html'
    expect(collapseHashToTopPage(url)).toBe(url)
  })

  it('preserves origin / port / path / pre-hash query byte-for-byte', () => {
    const input =
      'http://example.com:1234/some/path/simulator.html?apiNamespaces=foo,bar#wx_app|pages/a/a|pages/b/b?scene=1001'
    const expected =
      'http://example.com:1234/some/path/simulator.html?apiNamespaces=foo,bar#wx_app|pages/b/b?scene=1001'
    expect(collapseHashToTopPage(input)).toBe(expected)
  })

  it('does not throw on weird inputs (empty hash, "#?", empty string)', () => {
    expect(() => collapseHashToTopPage('http://x:1/foo#')).not.toThrow()
    expect(() => collapseHashToTopPage('http://x:1/foo#?')).not.toThrow()
    expect(() => collapseHashToTopPage('')).not.toThrow()
  })
})
