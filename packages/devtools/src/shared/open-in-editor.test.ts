/**
 * Unit tests for the "click a console file link → open in Monaco" pure helpers.
 *
 * These pin the encode/decode round-trip and the DevTools-resource-URL →
 * project-relative-path mapping that the main process relies on to translate a
 * `devtools-open-url` sentinel into an `editor:openFile` payload. The Electron/
 * DevTools-front-end glue (setOpenResourceHandler injection + the
 * `devtools-open-url` listener in view-manager) is not unit-testable here and is
 * verified manually; this isolates the logic that decides WHICH file + position.
 */
import { describe, it, expect } from 'vitest'
import {
  OPEN_IN_EDITOR_SCHEME,
  encodeOpenInEditorUrl,
  decodeOpenInEditorUrl,
  resourceUrlToProjectRelativePath,
} from './open-in-editor'

describe('encode/decode open-in-editor sentinel URL', () => {
  it('round-trips url + line + column', () => {
    const req = { url: 'http://127.0.0.1:5173/wxabc/pages/home/home.js', line: 12, column: 4 }
    const encoded = encodeOpenInEditorUrl(req)
    expect(encoded.startsWith(`${OPEN_IN_EDITOR_SCHEME}:`)).toBe(true)
    expect(decodeOpenInEditorUrl(encoded)).toEqual(req)
  })

  it('round-trips a url with no position', () => {
    const req = { url: 'http://127.0.0.1:5173/wxabc/pages/home/home.js' }
    expect(decodeOpenInEditorUrl(encodeOpenInEditorUrl(req))).toEqual(req)
  })

  it('preserves a url containing query/hash characters (carried in the query, not the path)', () => {
    const req = { url: 'http://127.0.0.1:5173/wxabc/a%20b/x.js?v=1#frag', line: 1 }
    expect(decodeOpenInEditorUrl(encodeOpenInEditorUrl(req))).toEqual(req)
  })

  it('truncates fractional line/column to integers', () => {
    const encoded = encodeOpenInEditorUrl({ url: 'http://h/x.js', line: 3.9, column: 2.5 })
    expect(decodeOpenInEditorUrl(encoded)).toEqual({ url: 'http://h/x.js', line: 3, column: 2 })
  })

  it('returns null for a non-sentinel URL (a real "open in new tab" link)', () => {
    expect(decodeOpenInEditorUrl('https://example.com/docs')).toBeNull()
    expect(decodeOpenInEditorUrl('about:blank')).toBeNull()
  })

  it('returns null for a sentinel missing the required url', () => {
    expect(decodeOpenInEditorUrl(`${OPEN_IN_EDITOR_SCHEME}:?l=3`)).toBeNull()
  })
})

describe('resourceUrlToProjectRelativePath', () => {
  it('strips the origin + appId segment, leaving the project-relative source path', () => {
    expect(
      resourceUrlToProjectRelativePath('http://127.0.0.1:5173/wxabc123/pages/home/home.js'),
    ).toBe('pages/home/home.js')
  })

  it('keeps a sub-package path intact (sub-package sources are still project-relative)', () => {
    expect(
      resourceUrlToProjectRelativePath('http://127.0.0.1:5173/wxabc123/subpkg/pages/x/x.js'),
    ).toBe('subpkg/pages/x/x.js')
  })

  it('percent-decodes encoded path segments the dev server added', () => {
    expect(
      resourceUrlToProjectRelativePath('http://127.0.0.1:5173/wxabc123/pages%2Fa/b.js'),
    ).toBe('pages/a/b.js')
  })

  it('gates on the expected origin when provided', () => {
    const url = 'http://127.0.0.1:5173/wxabc123/pages/home/home.js'
    expect(resourceUrlToProjectRelativePath(url, 'http://127.0.0.1:5173')).toBe('pages/home/home.js')
    // A frame from a different origin (framework / other server) does not map.
    expect(resourceUrlToProjectRelativePath(url, 'http://127.0.0.1:9999')).toBeNull()
  })

  it('returns null for non-http schemes (webpack://, node:, data:)', () => {
    expect(resourceUrlToProjectRelativePath('webpack:///./src/x.js')).toBeNull()
    expect(resourceUrlToProjectRelativePath('node:internal/bootstrap')).toBeNull()
    expect(resourceUrlToProjectRelativePath('data:application/json;base64,e30=')).toBeNull()
  })

  it('returns null when there is no source path after the appId segment', () => {
    expect(resourceUrlToProjectRelativePath('http://127.0.0.1:5173/wxabc123')).toBeNull()
    expect(resourceUrlToProjectRelativePath('http://127.0.0.1:5173/')).toBeNull()
  })

  it('returns null for an unparseable URL', () => {
    expect(resourceUrlToProjectRelativePath('not a url')).toBeNull()
    expect(resourceUrlToProjectRelativePath('')).toBeNull()
  })
})
