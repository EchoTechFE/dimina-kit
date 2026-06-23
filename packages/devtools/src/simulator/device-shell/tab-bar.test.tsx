/**
 * Unit tests for `resolveIcon` — the tabBar icon URL builder.
 *
 * Guards the contract that the compiler rewrites tabBar iconPath to an
 * absolute, server-root path (`/<appId>/main/static/…`) and `resourceBaseUrl`
 * is the dev-server origin. The resolved URL must keep the `<appId>` segment so
 * it matches what the dev server actually serves; stripping it yields a 404 and
 * a blank tab icon.
 */
import { describe, it, expect } from 'vitest'
import { resolveIcon } from './tab-bar'

const APP_ID = 'wxfca8a42caa0f8c5a'
const BASE = 'http://localhost:62698/'

describe('resolveIcon', () => {
  it('keeps the <appId> segment for a compiler-rewritten absolute path', () => {
    const url = resolveIcon(`/${APP_ID}/main/static/pm1dc_explore.png`, BASE, APP_ID)
    expect(url).toBe(`http://localhost:62698/${APP_ID}/main/static/pm1dc_explore.png`)
  })

  it('does not collapse an absolute path down to /main/static (the 404 bug)', () => {
    const url = resolveIcon(`/${APP_ID}/main/static/pm1dc_explore.png`, BASE, APP_ID)
    expect(url).not.toBe('http://localhost:62698/main/static/pm1dc_explore.png')
    expect(url).toContain(`/${APP_ID}/main/static/`)
  })

  it('roots a bare in-package relative path at <appId>/main', () => {
    const url = resolveIcon('static/explore.png', BASE, APP_ID)
    expect(url).toBe(`http://localhost:62698/${APP_ID}/main/static/explore.png`)
  })

  it('returns absolute http(s)/data/protocol-relative URLs unchanged', () => {
    expect(resolveIcon('https://cdn.example.com/i.png', BASE, APP_ID)).toBe('https://cdn.example.com/i.png')
    expect(resolveIcon('data:image/png;base64,AAAA', BASE, APP_ID)).toBe('data:image/png;base64,AAAA')
    expect(resolveIcon('//cdn.example.com/i.png', BASE, APP_ID)).toBe('//cdn.example.com/i.png')
  })

  it('returns null for empty input or a missing base URL', () => {
    expect(resolveIcon(undefined, BASE, APP_ID)).toBeNull()
    expect(resolveIcon('', BASE, APP_ID)).toBeNull()
    expect(resolveIcon('   ', BASE, APP_ID)).toBeNull()
    expect(resolveIcon(`/${APP_ID}/main/static/x.png`, null, APP_ID)).toBeNull()
  })
})
