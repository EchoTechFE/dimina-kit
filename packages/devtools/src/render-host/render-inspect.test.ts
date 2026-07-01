/**
 * Behavior tests for the render-host guest IIFE (`render-inspect.ts`), bundled
 * to `dist/render-host/render-inspect.js` and injected via `executeJavaScript`
 * into the render guest's MAIN world (see `main/services/render-inspect/index.ts`
 * — that file's own tests only exercise the injection/CDP plumbing with a fake
 * `WebContents`, never this module's actual DOM logic).
 *
 * `setWxmlObserving` is driven by main on `SimulatorWxmlChannel.SetActive` /
 * render events, which can race the render guest's own document parsing: main
 * may call `setWxmlObserving(true)` before the page's `document.body` exists
 * yet (e.g. right after navigation, before the guest's HTML has parsed a
 * `<body>`). `MutationObserver.observe(null, …)` throws synchronously, so the
 * guest must defer to `DOMContentLoaded` instead of crashing the injected
 * script.
 *
 * We run this directly in jsdom (vitest.config.ts sets `environment: 'jsdom'`
 * globally) since the module is plain DOM code with no Electron/Node imports.
 * Each test re-imports the module after `vi.resetModules()` + clearing
 * `globalThis.__diminaRenderInspect`, because the module's top-level
 * `if (!g.__diminaRenderInspect)` guard only initializes once per instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface RenderInspectApi {
  getWxml(): unknown
  highlightElement(sid: string): unknown
  elementFor(sid: string): HTMLElement | null
  unhighlightElement(): void
  setWxmlObserving(on: boolean): void
}

type Globals = typeof globalThis & {
  __diminaRenderInspect?: RenderInspectApi
  DiminaRenderBridge?: { invoke: ReturnType<typeof vi.fn> }
}

const g = globalThis as Globals

function getApi(): RenderInspectApi {
  const api = g.__diminaRenderInspect
  if (!api) throw new Error('__diminaRenderInspect was not installed by the render-inspect import')
  return api
}

/** Detach the current `<body>` so `document.body` reads null, mirroring a
 * guest document whose HTML hasn't finished parsing a body yet. */
function removeBody(): void {
  document.body?.remove()
}

/** Re-attach a fresh `<body>` and fire `DOMContentLoaded`, mirroring the guest
 * document finishing its parse after a deferred `setWxmlObserving(true)`. */
function completeBodyParse(): HTMLElement {
  const body = document.createElement('body')
  document.documentElement.appendChild(body)
  document.dispatchEvent(new Event('DOMContentLoaded'))
  return body
}

beforeEach(() => {
  vi.resetModules()
  delete g.__diminaRenderInspect
  g.DiminaRenderBridge = { invoke: vi.fn() }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  // Leave a body in place for jsdom/test-setup sanity between test files.
  if (!document.body) document.documentElement.appendChild(document.createElement('body'))
})

describe('render-inspect guest IIFE — setWxmlObserving defers until document.body exists', () => {
  it('does not throw when setWxmlObserving(true) is called before document.body exists', async () => {
    removeBody()
    expect(document.body).toBeNull()

    await import('./render-inspect.js')
    const api = getApi()

    expect(() => api.setWxmlObserving(true)).not.toThrow()
  })

  it('begins observing once DOMContentLoaded fires after a deferred setWxmlObserving(true)', async () => {
    vi.useFakeTimers()
    removeBody()

    await import('./render-inspect.js')
    const api = getApi()
    api.setWxmlObserving(true)

    const body = completeBodyParse()
    body.appendChild(document.createElement('div'))

    // Let the MutationObserver's microtask-delivered callback run, then clear
    // the 200ms notify debounce.
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)

    expect(g.DiminaRenderBridge?.invoke).toHaveBeenCalledWith({
      type: 'wxmlChanged',
      target: 'container',
      body: {},
    })
  })

  it('observes immediately when document.body already exists at call time', async () => {
    vi.useFakeTimers()
    // A fresh document.body from the jsdom test environment; ensure it's present.
    if (!document.body) document.documentElement.appendChild(document.createElement('body'))

    await import('./render-inspect.js')
    const api = getApi()
    api.setWxmlObserving(true)

    document.body?.appendChild(document.createElement('div'))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)

    expect(g.DiminaRenderBridge?.invoke).toHaveBeenCalledWith({
      type: 'wxmlChanged',
      target: 'container',
      body: {},
    })
  })
})
