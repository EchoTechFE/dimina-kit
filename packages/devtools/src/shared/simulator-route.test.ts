import { describe, it, expect } from 'vitest'
import {
  buildRouteSearch,
  buildSimulatorUrl,
  buildSimulatorUrlFromSpec,
  collapseRouteToTopPage,
  decodePageSpec,
  encodePageSpec,
  encodeRouteValue,
  getCurrentPagePath,
  parseLocationRoute,
  parseRoute,
} from './simulator-route'

// ── Low-level encode / decode ────────────────────────────────────────────────

describe('encodeRouteValue', () => {
  it('un-escapes `/` for readability', () => {
    expect(encodeRouteValue('pages/index/index')).toBe('pages/index/index')
  })

  it('encodes `?`, `&`, `=`, and other reserved chars', () => {
    expect(encodeRouteValue('foo?bar=baz&k=v')).toBe('foo%3Fbar%3Dbaz%26k%3Dv')
  })

  it('encodes spaces and non-ASCII', () => {
    expect(encodeRouteValue('a b c')).toBe('a%20b%20c')
    expect(encodeRouteValue('页面')).toBe('%E9%A1%B5%E9%9D%A2')
  })
})

describe('encodePageSpec / decodePageSpec', () => {
  it('encodes empty query as bare path (no trailing `?`)', () => {
    expect(encodePageSpec({ pagePath: 'pages/index/index', query: {} })).toBe('pages/index/index')
  })

  it('encodes a single query param', () => {
    expect(encodePageSpec({ pagePath: 'pages/a/a', query: { id: '42' } })).toBe('pages/a/a?id=42')
  })

  it('encodes multiple query params (insertion order)', () => {
    expect(
      encodePageSpec({ pagePath: 'pages/a/a', query: { id: '42', from: 'home' } }),
    ).toBe('pages/a/a?id=42&from=home')
  })

  it('decodes a bare path (no query)', () => {
    expect(decodePageSpec('pages/a/a')).toEqual({ pagePath: 'pages/a/a', query: {} })
  })

  it('decodes a path with query', () => {
    expect(decodePageSpec('pages/a/a?id=42&from=home')).toEqual({
      pagePath: 'pages/a/a',
      query: { id: '42', from: 'home' },
    })
  })

  it('decodes URL-encoded query values', () => {
    expect(decodePageSpec('pages/a/a?msg=hello%20world')).toEqual({
      pagePath: 'pages/a/a',
      query: { msg: 'hello world' },
    })
  })

  it('tolerates a trailing `?` with empty query string', () => {
    expect(decodePageSpec('pages/a/a?')).toEqual({ pagePath: 'pages/a/a', query: {} })
  })

  it('round-trips encode→decode', () => {
    const spec = { pagePath: 'pages/x/x', query: { a: '1', b: 'two words' } }
    expect(decodePageSpec(encodePageSpec(spec))).toEqual(spec)
  })
})

// ── Build ────────────────────────────────────────────────────────────────────

describe('buildRouteSearch', () => {
  it('produces appId=&entry=&page= with entry === page', () => {
    const s = buildRouteSearch('wx123', { pagePath: 'pages/a/a', query: {} })
    expect(s).toBe('appId=wx123&entry=pages/a/a&page=pages/a/a')
  })

  it('URL-encodes embedded `?` in entry/page values', () => {
    const s = buildRouteSearch('wx123', { pagePath: 'pages/a/a', query: { id: '42' } })
    expect(s).toBe('appId=wx123&entry=pages/a/a%3Fid%3D42&page=pages/a/a%3Fid%3D42')
  })

  it('appends extras verbatim (apiNamespaces etc.)', () => {
    const s = buildRouteSearch('wx123', { pagePath: 'pages/a/a', query: {} }, { apiNamespaces: 'qd,mt' })
    expect(s).toBe('appId=wx123&entry=pages/a/a&page=pages/a/a&apiNamespaces=qd,mt')
  })

  it('drops extras that collide with route keys (caller can\'t accidentally clobber appId)', () => {
    const s = buildRouteSearch('wx123', { pagePath: 'pages/a/a', query: {} }, { appId: 'OVERRIDE', extra: 'ok' })
    expect(s).toContain('appId=wx123')
    expect(s).not.toContain('OVERRIDE')
    expect(s).toContain('extra=ok')
  })
})

describe('buildSimulatorUrlFromSpec', () => {
  it('builds a URL with default host=localhost and pathname=/simulator.html', () => {
    const url = buildSimulatorUrlFromSpec({
      appId: 'wx123',
      page: { pagePath: 'pages/a/a', query: {} },
      port: 9000,
    })
    expect(url).toBe('http://localhost:9000/simulator.html?appId=wx123&entry=pages/a/a&page=pages/a/a')
  })

  it('honours custom host/pathname overrides', () => {
    const url = buildSimulatorUrlFromSpec({
      appId: 'wx123',
      page: { pagePath: 'pages/a/a', query: {} },
      port: 8080,
      host: '127.0.0.1',
      pathname: '/preview.html',
    })
    expect(url).toBe('http://127.0.0.1:8080/preview.html?appId=wx123&entry=pages/a/a&page=pages/a/a')
  })
})

describe('buildSimulatorUrl (CompileConfig adapter)', () => {
  it('uses default startPage when empty', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: '',
      scene: 1001,
      queryParams: [],
    }, 9000)
    expect(url).toContain('entry=pages/index/index%3Fscene%3D1001')
  })

  it('embeds compileConfig queryParams plus scene into the entry/page spec', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/detail/detail',
      scene: 1002,
      queryParams: [
        { key: 'id', value: '42' },
        { key: 'from', value: 'home' },
      ],
    }, 9000)
    const route = parseRoute(url)
    expect(route).not.toBeNull()
    expect(route!.entry.pagePath).toBe('pages/detail/detail')
    expect(route!.entry.query).toEqual({ id: '42', from: 'home', scene: '1002' })
  })

  it('filters empty query param keys', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/a/a',
      scene: 1001,
      queryParams: [
        { key: '', value: 'ignored' },
        { key: 'valid', value: 'yes' },
      ],
    }, 9000)
    expect(url).not.toContain('ignored')
    const route = parseRoute(url)
    expect(route!.entry.query.valid).toBe('yes')
  })

  it('appends apiNamespaces as a non-route extra param', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/a/a',
      scene: 1001,
      queryParams: [],
    }, 9000, ['qd', 'mt'])
    expect(url).toContain('apiNamespaces=qd,mt')
    const route = parseRoute(url)
    expect(route!.entry.pagePath).toBe('pages/a/a')
  })
})

// ── Parse ────────────────────────────────────────────────────────────────────

describe('parseLocationRoute (query format)', () => {
  it('parses the canonical entry===page URL', () => {
    const r = parseLocationRoute('?appId=wx123&entry=pages/a/a&page=pages/a/a', '')
    expect(r).toEqual({
      appId: 'wx123',
      entry: { pagePath: 'pages/a/a', query: {} },
      current: { pagePath: 'pages/a/a', query: {} },
    })
  })

  it('parses distinct entry and current (navigated state)', () => {
    const r = parseLocationRoute('?appId=wx123&entry=pages/a/a&page=pages/b/b', '')
    expect(r!.entry.pagePath).toBe('pages/a/a')
    expect(r!.current.pagePath).toBe('pages/b/b')
  })

  it('decodes URL-encoded `?` inside entry/page values', () => {
    const r = parseLocationRoute(
      '?appId=wx123&entry=pages/a/a%3Fscene%3D1001&page=pages/a/a%3Fscene%3D1001',
      '',
    )
    expect(r!.entry.query).toEqual({ scene: '1001' })
  })

  it('falls back to entry when page param is missing', () => {
    const r = parseLocationRoute('?appId=wx123&entry=pages/a/a', '')
    expect(r!.current.pagePath).toBe('pages/a/a')
  })

  it('returns null when appId is missing', () => {
    expect(parseLocationRoute('?entry=pages/a/a', '')).toBeNull()
  })

  it('returns null when entry is missing', () => {
    expect(parseLocationRoute('?appId=wx123', '')).toBeNull()
  })
})

describe('parseLocationRoute (legacy hash format)', () => {
  it('parses `#appid|page1|page2`', () => {
    const r = parseLocationRoute('', '#wx123|pages/a/a|pages/b/b')
    expect(r!.appId).toBe('wx123')
    expect(r!.entry.pagePath).toBe('pages/a/a')
    expect(r!.current.pagePath).toBe('pages/b/b')
  })

  it('parses per-segment ?query (an earlier bug was first-? truncation)', () => {
    const r = parseLocationRoute('', '#wx123|pages/a/a?scene=1001|pages/b/b?k=v')
    expect(r!.entry.query).toEqual({ scene: '1001' })
    expect(r!.current.query).toEqual({ k: 'v' })
  })

  it('parses even-older `#appid/pagePath?q=v` (single page)', () => {
    const r = parseLocationRoute('', '#wx123/pages/a/a?k=v')
    expect(r!.appId).toBe('wx123')
    expect(r!.entry.pagePath).toBe('pages/a/a')
    expect(r!.entry.query).toEqual({ k: 'v' })
    expect(r!.current).toEqual(r!.entry)
  })

  it('prefers query format over legacy hash when both present', () => {
    const r = parseLocationRoute('?appId=wxQ&entry=pages/q/q', '#wxH|pages/h/h')
    expect(r!.appId).toBe('wxQ')
    expect(r!.entry.pagePath).toBe('pages/q/q')
  })

  it('returns null on an empty location', () => {
    expect(parseLocationRoute('', '')).toBeNull()
  })

  it('returns null for malformed hashes', () => {
    expect(parseLocationRoute('', '#noslashes')).toBeNull()
    expect(parseLocationRoute('', '#|onlysep')).toBeNull()
  })
})

describe('parseRoute (full URL)', () => {
  it('handles a real URL', () => {
    const url = 'http://localhost:9000/simulator.html?appId=wx123&entry=pages/a/a%3Fscene%3D1001&page=pages/a/a%3Fscene%3D1001&apiNamespaces=qd'
    const r = parseRoute(url)
    expect(r!.appId).toBe('wx123')
    expect(r!.entry.query.scene).toBe('1001')
  })

  it('returns null for empty / non-URL input without throwing', () => {
    expect(parseRoute('')).toBeNull()
    expect(parseRoute('not a url')).toBeNull()
  })
})

describe('getCurrentPagePath', () => {
  it('returns the current page path (no query)', () => {
    expect(
      getCurrentPagePath('http://x:1/simulator.html?appId=wx&entry=pages/a/a&page=pages/b/b%3Fk%3Dv'),
    ).toBe('pages/b/b')
  })

  it('returns empty string for unparseable input', () => {
    expect(getCurrentPagePath('')).toBe('')
  })
})

// ── Collapse ─────────────────────────────────────────────────────────────────

describe('collapseRouteToTopPage', () => {
  it('returns unchanged when entry already equals current', () => {
    const url = 'http://x:1/simulator.html?appId=wx&entry=pages/a/a%3Fscene%3D1001&page=pages/a/a%3Fscene%3D1001'
    expect(collapseRouteToTopPage(url)).toBe(url)
  })

  it('rewrites entry to match current so reload boots only the top page', () => {
    const out = collapseRouteToTopPage(
      'http://x:1/simulator.html?appId=wx&entry=pages/a/a&page=pages/b/b%3Fk%3Dv',
    )
    const r = parseRoute(out)
    expect(r!.entry.pagePath).toBe('pages/b/b')
    expect(r!.entry.query).toEqual({ k: 'v' })
    expect(r!.current.pagePath).toBe('pages/b/b')
  })

  it('preserves non-route extras (apiNamespaces)', () => {
    const out = collapseRouteToTopPage(
      'http://x:1/simulator.html?appId=wx&entry=pages/a/a&page=pages/b/b&apiNamespaces=foo,bar',
    )
    expect(out).toContain('apiNamespaces=foo,bar')
  })

  it('returns unchanged when the URL has no route params', () => {
    const url = 'http://x:1/simulator.html'
    expect(collapseRouteToTopPage(url)).toBe(url)
  })

  it('does not throw on weird inputs', () => {
    expect(() => collapseRouteToTopPage('')).not.toThrow()
    expect(() => collapseRouteToTopPage('not a url')).not.toThrow()
  })
})
