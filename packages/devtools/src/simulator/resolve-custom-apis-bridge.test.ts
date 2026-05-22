/**
 * Step 6 / Requirement D — `installCustomApisBridge` missing-warn.
 *
 * A host that supplies a custom preload but forgets to call
 * `installCustomApisBridge()` leaves `window.__diminaCustomApis` undefined.
 * Every `wx.<customApi>()` from the simulated mini-program then silently
 * no-ops. `resolveCustomApisBridge` turns that silent failure into a
 * `console.warn` — but only inside Electron, where the bridge IS expected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveCustomApisBridge, type CustomApisBridge } from './resolve-custom-apis-bridge.js'

const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Electron/41.2.1 Safari/537.36'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Safari/537.36'

function fakeWindow(opts: {
  ua: string
  bridge?: CustomApisBridge
}): Pick<Window, 'navigator'> & { __diminaCustomApis?: CustomApisBridge } {
  return {
    navigator: { userAgent: opts.ua } as Navigator,
    __diminaCustomApis: opts.bridge,
  }
}

const stubBridge: CustomApisBridge = {
  list: async () => [],
  invoke: async () => undefined,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveCustomApisBridge', () => {
  it('returns the bridge and does not warn when it is present (Electron)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = resolveCustomApisBridge(fakeWindow({ ua: ELECTRON_UA, bridge: stubBridge }))
    expect(bridge).toBe(stubBridge)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when running inside Electron but the bridge is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = resolveCustomApisBridge(fakeWindow({ ua: ELECTRON_UA }))
    expect(bridge).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    // The warn must name the omitted call so a host can act on it.
    expect(String(warn.mock.calls[0]?.[0])).toContain('installCustomApisBridge')
  })

  it('stays silent when the bridge is missing outside Electron (dev-server / browser)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = resolveCustomApisBridge(fakeWindow({ ua: BROWSER_UA }))
    expect(bridge).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
