/**
 * Unit tests for the service-host `importScripts` sourcemap rewrite.
 *
 * THE BUG THIS GUARDS: under native-host the service host loads each compiled
 * `logic.js` via a synchronous-XHR + `(0, eval)(...)` shim (preload.cjs). The
 * compiled bundle ships a RELATIVE `//# sourceMappingURL=logic.js.map`. An
 * eval'd script has no base URL of its own, so DevTools resolves that relative
 * map against the service-host DOCUMENT (`file://…/service-host/service.html`)
 * and 404s — every console file:line link then points at the COMPILED bundle
 * instead of the developer's original source. `rewriteSourceMappingUrl` resolves
 * the directive to an absolute dev-server URL so the `.map` is fetchable again.
 *
 * These assert the exact transform contract the fix relies on.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { rewriteSourceMappingUrl } = require('./sourcemap-rewrite.cjs') as {
  rewriteSourceMappingUrl: (source: string, scriptUrl: string) => string
}

const SCRIPT_URL = 'http://127.0.0.1:5173/wxabc123/pages%2Fhome/logic.js'

describe('rewriteSourceMappingUrl', () => {
  it('rewrites a relative sourceMappingURL to an absolute dev-server URL', () => {
    const src = 'modDefine("a", function(){});\n//# sourceMappingURL=logic.js.map\n'
    const out = rewriteSourceMappingUrl(src, SCRIPT_URL)
    // The map now resolves against the script URL, not the file:// document.
    expect(out).toContain(
      '//# sourceMappingURL=http://127.0.0.1:5173/wxabc123/pages%2Fhome/logic.js.map',
    )
    // The original relative directive is gone (no stale 404-bound line remains).
    expect(out).not.toContain('//# sourceMappingURL=logic.js.map')
    // The actual code is preserved verbatim.
    expect(out).toContain('modDefine("a", function(){});')
  })

  it('preserves the bundle code body byte-for-byte before the directive', () => {
    const code = 'const x = 1;\nconsole.log(x);'
    const out = rewriteSourceMappingUrl(`${code}\n//# sourceMappingURL=logic.js.map`, SCRIPT_URL)
    expect(out.startsWith(code)).toBe(true)
  })

  it('resolves a sibling .map even when the directive uses the legacy //@ form', () => {
    const src = 'code();\n//@ sourceMappingURL=logic.js.map'
    const out = rewriteSourceMappingUrl(src, SCRIPT_URL)
    expect(out).toContain(
      '//# sourceMappingURL=http://127.0.0.1:5173/wxabc123/pages%2Fhome/logic.js.map',
    )
  })

  it('leaves an already-absolute http(s) sourceMappingURL untouched', () => {
    const abs = 'http://cdn.example.com/x.js.map'
    const src = `code();\n//# sourceMappingURL=${abs}`
    expect(rewriteSourceMappingUrl(src, SCRIPT_URL)).toBe(src)
  })

  it('leaves an inline data: sourcemap untouched', () => {
    const src = 'code();\n//# sourceMappingURL=data:application/json;base64,eyJ2IjozfQ=='
    expect(rewriteSourceMappingUrl(src, SCRIPT_URL)).toBe(src)
  })

  it('leaves source with no sourceMappingURL directive untouched', () => {
    const src = 'modDefine("a", function(){});\n'
    expect(rewriteSourceMappingUrl(src, SCRIPT_URL)).toBe(src)
  })

  it('rewrites only the LAST directive when the body contains more than one', () => {
    // The compiler appends exactly one as the final line, but a bundle that
    // concatenated a vendor chunk could carry an earlier stray directive; the
    // operative one is the last, which is what DevTools honors.
    const src = [
      'vendor();',
      '//# sourceMappingURL=vendor.js.map',
      'app();',
      '//# sourceMappingURL=logic.js.map',
    ].join('\n')
    const out = rewriteSourceMappingUrl(src, SCRIPT_URL)
    expect(out).toContain(
      '//# sourceMappingURL=http://127.0.0.1:5173/wxabc123/pages%2Fhome/logic.js.map',
    )
    // The earlier directive is left as-is (only the last governs resolution).
    expect(out).toContain('//# sourceMappingURL=vendor.js.map')
  })

  it('returns the input unchanged when the script URL is unparseable', () => {
    const src = 'code();\n//# sourceMappingURL=logic.js.map'
    expect(rewriteSourceMappingUrl(src, 'not a url')).toBe(src)
  })

  it('returns non-string / empty input unchanged (never throws on bad data)', () => {
    expect(rewriteSourceMappingUrl('', SCRIPT_URL)).toBe('')
    // @ts-expect-error exercising the runtime guard against non-string bodies
    expect(rewriteSourceMappingUrl(undefined, SCRIPT_URL)).toBe(undefined)
  })
})
