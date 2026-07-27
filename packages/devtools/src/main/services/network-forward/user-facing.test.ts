/**
 * Pure-function tests for `isUserFacingRequest` — the judgment call that
 * decides whether a captured network request belongs on the user-facing
 * DevTools Network panel (a business request the mini-app author cares about)
 * or should be hidden there (a framework/host-internal resource load). No
 * mocking: this is a pure `(url, baseUrl?) => boolean` function.
 */
import { describe, expect, it } from 'vitest'
import { isUserFacingRequest } from './user-facing.js'

describe('isUserFacingRequest', () => {
  it('treats an ordinary http business request as user-facing', () => {
    expect(isUserFacingRequest('http://example.com/api/foo')).toBe(true)
  })

  it('treats an https remote resource (e.g. a page image) as user-facing', () => {
    expect(isUserFacingRequest('https://cdn.example.com/img.png')).toBe(true)
  })

  it('treats a wss websocket request as user-facing', () => {
    expect(isUserFacingRequest('wss://echo.example.com/socket')).toBe(true)
  })

  it('hides a file:// request (local render-host asset)', () => {
    expect(isUserFacingRequest('file:///Users/x/dist/render-host/pageFrame.html')).toBe(false)
  })

  it('hides a difile:// request (simulator temp-file protocol)', () => {
    expect(isUserFacingRequest('difile://simulator-temp/foo.png')).toBe(false)
  })

  it('hides a devtools:// request (bundled front-end asset)', () => {
    expect(isUserFacingRequest('devtools://devtools/bundled/x.js')).toBe(false)
  })

  it('hides a data: URL', () => {
    expect(isUserFacingRequest('data:image/png;base64,AAAA')).toBe(false)
  })

  it('hides a request whose origin matches the given resourceServerBaseUrl', () => {
    expect(isUserFacingRequest('http://127.0.0.1:54321/dist/foo.js', ['http://127.0.0.1:54321/'])).toBe(false)
  })

  it('treats a request on a different port than the resource server as user-facing', () => {
    expect(isUserFacingRequest('http://127.0.0.1:9999/other', ['http://127.0.0.1:54321/'])).toBe(true)
  })

  it('treats the resource-server URL as user-facing when no baseUrl is given to compare against', () => {
    expect(isUserFacingRequest('http://127.0.0.1:54321/dist/foo.js')).toBe(true)
  })

  // Modifying test: real CDP `Network.requestWillBeSent.request.url` is
  // always a fully qualified URL — an unparseable string only happens for
  // hand-authored placeholder input (and this codebase's existing
  // network-forward test suite uses exactly that, e.g. `url: 'a'`, in tests
  // that aren't about URL semantics at all). Hiding those wholesale would
  // have silently broken every one of those pre-existing tests' user-facing
  // sink assertions. Fail OPEN (treat as user-facing) instead: the worse
  // failure mode is silently swallowing real business traffic, not
  // occasionally over-showing an unparseable one (which can't happen from
  // real CDP data anyway).
  it('treats a malformed URL string as user-facing (fail open)', () => {
    expect(isUserFacingRequest('not a url')).toBe(true)
  })

  it('treats an empty string as user-facing (fail open)', () => {
    expect(isUserFacingRequest('')).toBe(true)
  })
})

describe('isUserFacingRequest — internalOrigins array (multiple host-internal servers)', () => {
  it('hides a request whose origin matches the only internal origin in a single-element array', () => {
    expect(isUserFacingRequest('http://127.0.0.1:54321/dist/foo.js', ['http://127.0.0.1:54321/'])).toBe(false)
  })

  it('hides a request whose origin matches the SECOND of two internal origins in the array', () => {
    // Simulates the real bug this contract exists for: the simulator shell's
    // own static-asset server is a separate origin from the mini-app resource
    // server, listed second in internalOrigins — it must still be excluded.
    expect(
      isUserFacingRequest('http://127.0.0.1:9876/simulator.js', [
        'http://127.0.0.1:54321/',
        'http://127.0.0.1:9876/',
      ]),
    ).toBe(false)
  })

  it('treats a request whose origin matches neither internal origin as user-facing', () => {
    expect(
      isUserFacingRequest('https://httpbin.org/get', [
        'http://127.0.0.1:54321/',
        'http://127.0.0.1:9876/',
      ]),
    ).toBe(true)
  })

  it('skips a null entry in internalOrigins and still matches a later non-null entry', () => {
    expect(
      isUserFacingRequest('http://localhost:12345/asset.js', [null, 'http://localhost:12345/']),
    ).toBe(false)
  })

  it('treats an array of all-undefined origins (no server available yet) the same as omitting the argument', () => {
    const url = 'http://example.com/api/foo'
    expect(isUserFacingRequest(url, [undefined, undefined])).toBe(true)
    expect(isUserFacingRequest(url)).toBe(true)
  })

  it('treats an empty internalOrigins array the same as no exclusions at all', () => {
    expect(isUserFacingRequest('http://example.com/api/foo', [])).toBe(true)
  })
})
