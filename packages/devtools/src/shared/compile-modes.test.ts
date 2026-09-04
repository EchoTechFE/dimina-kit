import { describe, it, expect } from 'vitest'
import {
  NORMAL_COMPILE_INDEX,
  compileConfigToMode,
  compileModeLabel,
  normalizeCompileModes,
  parseQueryString,
  resolveCompileConfig,
  routeToMode,
  stringifyQueryParams,
} from './compile-modes.js'
import { DEFAULT_SCENE } from './constants.js'
import type { CompileConfig, CompileMode, CompileModes } from './types.js'

// ── parseQueryString ─────────────────────────────────────────────────────────

describe('parseQueryString', () => {
  it('parses key=value pairs in order', () => {
    expect(parseQueryString('a=1&b=2')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ])
  })

  it('returns an empty array for an empty string', () => {
    expect(parseQueryString('')).toEqual([])
  })

  it('parses a bare key (no `=`) as an empty-string value', () => {
    expect(parseQueryString('b')).toEqual([{ key: 'b', value: '' }])
  })

  it('preserves duplicate keys and their order', () => {
    expect(parseQueryString('a=1&a=2')).toEqual([
      { key: 'a', value: '1' },
      { key: 'a', value: '2' },
    ])
  })

  it('decodes percent-encoded values', () => {
    expect(parseQueryString('msg=hello%20world')).toEqual([{ key: 'msg', value: 'hello world' }])
  })

  it('keeps `=` inside a value by splitting only on the first `=`', () => {
    expect(parseQueryString('a=b=c')).toEqual([{ key: 'a', value: 'b=c' }])
  })
})

// ── stringifyQueryParams ─────────────────────────────────────────────────────

describe('stringifyQueryParams', () => {
  it('joins key=value pairs with `&`', () => {
    expect(stringifyQueryParams([{ key: 'a', value: '1' }, { key: 'b', value: '2' }])).toBe('a=1&b=2')
  })

  it('returns an empty string for an empty array', () => {
    expect(stringifyQueryParams([])).toBe('')
  })

  it('drops rows whose key is empty', () => {
    expect(
      stringifyQueryParams([{ key: '', value: 'ignored' }, { key: 'valid', value: 'yes' }]),
    ).toBe('valid=yes')
  })

  it('percent-encodes special characters in keys and values', () => {
    expect(stringifyQueryParams([{ key: 'a b', value: '1&2' }])).toBe('a%20b=1%262')
  })
})

// ── parse/stringify round trip ───────────────────────────────────────────────

describe('parseQueryString / stringifyQueryParams round trip', () => {
  it('is the identity for a canonical query string', () => {
    const canonical = 'a=1&b=hello&c=3'
    expect(stringifyQueryParams(parseQueryString(canonical))).toBe(canonical)
  })
})

// ── resolveCompileConfig ─────────────────────────────────────────────────────

describe('resolveCompileConfig', () => {
  it('resolves to the normal-compile default when current is -1', () => {
    const modes: CompileModes = { current: NORMAL_COMPILE_INDEX, list: [] }
    expect(resolveCompileConfig(modes)).toEqual({ startPage: '', scene: DEFAULT_SCENE, queryParams: [] })
  })

  it('resolves the selected mode by index', () => {
    const modes: CompileModes = {
      current: 0,
      list: [{ name: 'foo', pathName: 'pages/a/a', query: 'id=1', scene: 1002 }],
    }
    expect(resolveCompileConfig(modes)).toEqual({
      startPage: 'pages/a/a',
      scene: 1002,
      queryParams: [{ key: 'id', value: '1' }],
    })
  })

  it('falls back to normal compile when current is a negative index other than -1', () => {
    const modes: CompileModes = {
      current: -2,
      list: [{ name: 'foo', pathName: 'pages/a/a', query: '', scene: 1002 }],
    }
    expect(resolveCompileConfig(modes)).toEqual({ startPage: '', scene: DEFAULT_SCENE, queryParams: [] })
  })

  it('falls back to normal compile when current is beyond the end of the list', () => {
    const modes: CompileModes = {
      current: 5,
      list: [{ name: 'foo', pathName: 'pages/a/a', query: '', scene: 1002 }],
    }
    expect(resolveCompileConfig(modes)).toEqual({ startPage: '', scene: DEFAULT_SCENE, queryParams: [] })
  })

  it('falls back to DEFAULT_SCENE when the selected mode has scene: null', () => {
    const modes: CompileModes = {
      current: 0,
      list: [{ name: 'foo', pathName: 'pages/a/a', query: '', scene: null }],
    }
    expect(resolveCompileConfig(modes).scene).toBe(DEFAULT_SCENE)
  })
})

// ── compileModeLabel ─────────────────────────────────────────────────────────

describe('compileModeLabel', () => {
  it('labels normal compile (current -1)', () => {
    expect(compileModeLabel({ current: NORMAL_COMPILE_INDEX, list: [] })).toBe('普通编译')
  })

  it('prefers the mode name when present', () => {
    expect(
      compileModeLabel({ current: 0, list: [{ name: 'my mode', pathName: 'pages/a/a', query: '', scene: null }] }),
    ).toBe('my mode')
  })

  it('falls back to pathName when name is empty', () => {
    expect(
      compileModeLabel({ current: 0, list: [{ name: '', pathName: 'pages/a/a', query: '', scene: null }] }),
    ).toBe('pages/a/a')
  })

  // A mode with no name and 启动页面 left on 默认为首页 still carries its own
  // params and scene, so labelling it 普通编译 would tell the user they are
  // running something they are not — only current === -1 may say 普通编译.
  it('never says 普通编译 for a selected mode, even with both name and pathName empty', () => {
    expect(
      compileModeLabel({ current: 0, list: [{ name: '', pathName: '', query: 'a=1', scene: null }] }),
    ).toBe('未命名模式')
  })
})

// ── normalizeCompileModes ────────────────────────────────────────────────────

describe('normalizeCompileModes', () => {
  it('falls back to the empty default for undefined', () => {
    expect(normalizeCompileModes(undefined)).toEqual({ current: NORMAL_COMPILE_INDEX, list: [] })
  })

  it('falls back to the empty default for null', () => {
    expect(normalizeCompileModes(null)).toEqual({ current: NORMAL_COMPILE_INDEX, list: [] })
  })

  it('falls back to the empty default for a string', () => {
    expect(normalizeCompileModes('not an object')).toEqual({ current: NORMAL_COMPILE_INDEX, list: [] })
  })

  it('falls back to the empty default for an array', () => {
    expect(normalizeCompileModes([1, 2, 3])).toEqual({ current: NORMAL_COMPILE_INDEX, list: [] })
  })

  it('falls back to the empty default for an empty object', () => {
    expect(normalizeCompileModes({})).toEqual({ current: NORMAL_COMPILE_INDEX, list: [] })
  })

  it('treats a non-array list as no modes', () => {
    expect(normalizeCompileModes({ current: 0, list: 'nope' })).toEqual({ current: NORMAL_COMPILE_INDEX, list: [] })
  })

  it('drops non-object entries and entries missing a string pathName', () => {
    const raw = {
      current: 1,
      list: [
        null,
        'nope',
        { name: 'no pathName' },
        { name: 'bad pathName', pathName: 42 },
        { name: 'ok', pathName: 'pages/a/a', query: 'x=1', scene: 1001 },
      ],
    }
    const result = normalizeCompileModes(raw)
    expect(result.list).toEqual([{ name: 'ok', pathName: 'pages/a/a', query: 'x=1', scene: 1001 }])
  })

  it('resets current to -1 when it is not an integer', () => {
    const raw = { current: 1.5, list: [{ pathName: 'pages/a/a' }] }
    expect(normalizeCompileModes(raw).current).toBe(NORMAL_COMPILE_INDEX)
  })

  it('resets current to -1 when it is not a number', () => {
    const raw = { current: '0', list: [{ pathName: 'pages/a/a' }] }
    expect(normalizeCompileModes(raw).current).toBe(NORMAL_COMPILE_INDEX)
  })

  it('resets current to -1 when it is out of range for the surviving list', () => {
    const raw = { current: 3, list: [{ pathName: 'pages/a/a' }] }
    expect(normalizeCompileModes(raw).current).toBe(NORMAL_COMPILE_INDEX)
  })

  it('preserves launchMode and partialCompile verbatim on each surviving entry', () => {
    const raw = {
      current: 0,
      list: [{ pathName: 'pages/a/a', launchMode: 'singleton', partialCompile: { pages: ['pages/a/a'] } }],
    }
    const result = normalizeCompileModes(raw)
    expect(result.list[0].launchMode).toBe('singleton')
    expect(result.list[0].partialCompile).toEqual({ pages: ['pages/a/a'] })
  })
})

// ── compileConfigToMode / routeToMode ────────────────────────────────────────

describe('compileConfigToMode', () => {
  it('builds a CompileMode from a resolved CompileConfig', () => {
    const config: CompileConfig = {
      startPage: 'pages/a/a',
      scene: 1002,
      queryParams: [{ key: 'id', value: '42' }],
    }
    expect(compileConfigToMode(config, 'my mode')).toEqual({
      name: 'my mode',
      pathName: 'pages/a/a',
      query: 'id=42',
      scene: 1002,
    })
  })

  it('produces an empty query string when queryParams is empty', () => {
    const config: CompileConfig = { startPage: 'pages/a/a', scene: 1001, queryParams: [] }
    expect(compileConfigToMode(config, 'my mode').query).toBe('')
  })
})

describe('routeToMode', () => {
  it('splits a route into pathName and query, with scene null', () => {
    expect(routeToMode('pages/a/b?x=1&y=2', 'my mode')).toEqual({
      name: 'my mode',
      pathName: 'pages/a/b',
      query: 'x=1&y=2',
      scene: null,
    })
  })

  it('produces an empty query string when the route has no `?`', () => {
    expect(routeToMode('pages/a/b', 'my mode')).toEqual({
      name: 'my mode',
      pathName: 'pages/a/b',
      query: '',
      scene: null,
    })
  })

  it('produces an empty query string for a route with a trailing bare `?`', () => {
    expect(routeToMode('pages/a/b?', 'my mode')).toEqual({
      name: 'my mode',
      pathName: 'pages/a/b',
      query: '',
      scene: null,
    })
  })
})

// ── cross-function composition ───────────────────────────────────────────────

describe('routeToMode feeding into resolveCompileConfig', () => {
  it('round-trips a captured route through a CompileModes selection', () => {
    const mode: CompileMode = routeToMode('pages/a/b?x=1', '')
    const config = resolveCompileConfig({ current: 0, list: [mode] })
    expect(config.startPage).toBe('pages/a/b')
    expect(config.queryParams).toEqual([{ key: 'x', value: '1' }])
  })
})
