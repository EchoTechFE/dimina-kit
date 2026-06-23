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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPEN_IN_EDITOR_SCHEME,
  buildDevtoolsProjectSourceLinksScript,
  encodeOpenInEditorUrl,
  decodeOpenInEditorUrl,
  projectSourceContextFromServiceHostUrl,
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

describe('project-aware console source locations', () => {
  const context = {
    projectRoot: '/workspace/demo',
    resourceBaseUrl: 'http://127.0.0.1:5173/',
    appId: 'wxabc123',
    outputRoot: 'main',
  }

  it('maps the compiler sourcemap absolute source path to a project-relative path', () => {
    expect(
      resourceUrlToProjectRelativePath('http://127.0.0.1:5173/pages/console-test.js', context),
    ).toBe('pages/console-test.js')
  })

  it('strips appId and output root from compiled resource URLs', () => {
    expect(
      resourceUrlToProjectRelativePath(
        'http://127.0.0.1:5173/wxabc123/main/pages/console-test.js',
        context,
      ),
    ).toBe('pages/console-test.js')
  })

  it('maps an absolute project file URL but rejects devtools/runtime file frames', () => {
    expect(
      resourceUrlToProjectRelativePath('file:///workspace/demo/pages/console-test.js', context),
    ).toBe('pages/console-test.js')
    expect(
      resourceUrlToProjectRelativePath(
        'file:///Volumes/jdisk/code/dimina-kit/packages/devtools/dist/service-host/preload.cjs',
        context,
      ),
    ).toBeNull()
    expect(
      resourceUrlToProjectRelativePath(
        '/Volumes/jdisk/code/dimina-kit/packages/devtools/dist/service-host/preload.cjs',
        context,
      ),
    ).toBeNull()
    expect(
      resourceUrlToProjectRelativePath('file:///workspace/dimina/fe/packages/service/dist/service.js', context),
    ).toBeNull()
    expect(resourceUrlToProjectRelativePath('node:events', context)).toBeNull()
    expect(resourceUrlToProjectRelativePath('electron/js2c/renderer_init', context)).toBeNull()
  })

  it('rejects a different HTTP origin instead of treating it as project source', () => {
    expect(
      resourceUrlToProjectRelativePath('http://localhost:9999/pages/console-test.js', context),
    ).toBeNull()
  })

  it('derives mapping context from the live service-host URL', () => {
    const serviceHostUrl =
      'file:///app/service-host/service.html?bridgeId=b1&appId=wxabc123' +
      '&pkgRoot=%2Fworkspace%2Fdemo&root=main' +
      '&resourceBaseUrl=http%3A%2F%2F127.0.0.1%3A5173%2F'
    expect(projectSourceContextFromServiceHostUrl(serviceHostUrl)).toEqual(context)
    expect(projectSourceContextFromServiceHostUrl(serviceHostUrl, '/workspace/demo/')).toEqual(context)
    expect(projectSourceContextFromServiceHostUrl(serviceHostUrl, '/workspace/active-project')).toBeNull()
  })
})

describe('DevTools console project-source link injection', () => {
  const context = {
    projectRoot: '/workspace/demo',
    resourceBaseUrl: 'http://127.0.0.1:5173/',
    appId: 'wxabc123',
    outputRoot: 'main',
  }
  const originalMutationObserver = window.MutationObserver
  let activeObservers: Set<MutationObserver>

  beforeEach(() => {
    document.body.replaceChildren()
    vi.useFakeTimers()
    activeObservers = new Set()
    class TrackedMutationObserver extends originalMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback)
        activeObservers.add(this)
      }

      override disconnect(): void {
        activeObservers.delete(this)
        super.disconnect()
      }
    }
    window.MutationObserver = TrackedMutationObserver
    Object.defineProperty(window, 'Host', {
      configurable: true,
      value: {
        InspectorFrontendHost: {
          setOpenResourceHandler: vi.fn(),
          openInNewTab: vi.fn(),
        },
      },
    })
  })

  afterEach(() => {
    const state = (window as typeof window & {
      __diminaProjectSourceLinksState__?: { dispose?: () => void }
    }).__diminaProjectSourceLinksState__
    state?.dispose?.()
    delete (window as typeof window & { __diminaProjectSourceLinksState__?: unknown })
      .__diminaProjectSourceLinksState__
    delete (window as typeof window & { Host?: unknown }).Host
    window.MutationObserver = originalMutationObserver
    vi.useRealTimers()
  })

  async function flushMutations(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  function inject(): void {
    window.eval(buildDevtoolsProjectSourceLinksScript(context))
  }

  it('rewrites dynamically-added project links inside nested shadow roots only', async () => {
    const outerHost = document.createElement('div')
    const outerRoot = outerHost.attachShadow({ mode: 'open' })
    const innerHost = document.createElement('div')
    const innerRoot = innerHost.attachShadow({ mode: 'open' })
    outerRoot.append(innerHost)
    document.body.append(outerHost)

    inject()

    const projectLink = document.createElement('span')
    projectLink.className = 'devtools-link'
    projectLink.title = 'http://127.0.0.1:5173/pages/console-test.js:75'
    projectLink.textContent = 'console-test.js:75'
    innerRoot.append(projectLink)

    const internalLocations = [
      'service.js:6',
      'file:///Volumes/jdisk/code/dimina-kit/packages/devtools/dist/service-host/preload.cjs:83',
      'node:events:508',
      'electron/js2c/renderer_init:2',
    ]
    const internalLinks = internalLocations.map((location) => {
      const link = document.createElement('span')
      link.className = 'devtools-link'
      link.title = location
      link.textContent = location
      innerRoot.append(link)
      return link
    })

    await flushMutations()

    expect(projectLink.textContent).toBe('pages/console-test.js:75')
    expect(internalLinks.map((link) => link.textContent)).toEqual(internalLocations)
  })

  it('disposes observers and polling timers before a repeated injection', () => {
    const host = document.createElement('div')
    host.attachShadow({ mode: 'open' })
    document.body.append(host)

    inject()
    const firstObserverCount = activeObservers.size
    expect(firstObserverCount).toBeGreaterThan(1)
    expect(vi.getTimerCount()).toBe(1)

    inject()

    expect(activeObservers.size).toBe(firstObserverCount)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(50)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('routes project source clicks through the existing open-resource contract', () => {
    inject()
    vi.advanceTimersByTime(50)

    const host = (window as typeof window & {
      Host: {
        InspectorFrontendHost: {
          setOpenResourceHandler: ReturnType<typeof vi.fn>
          openInNewTab: ReturnType<typeof vi.fn>
        }
      }
    }).Host.InspectorFrontendHost
    const handler = host.setOpenResourceHandler.mock.calls[0]?.[0] as
      | ((url: string, line: number, column: number) => void)
      | undefined
    expect(handler).toBeTypeOf('function')

    handler?.('http://127.0.0.1:5173/pages/console-test.js', 74, 2)
    expect(host.openInNewTab).toHaveBeenCalledWith(
      encodeOpenInEditorUrl({
        url: 'http://127.0.0.1:5173/pages/console-test.js',
        line: 74,
        column: 2,
      }),
    )

    handler?.('node:events', 507, 0)
    expect(host.openInNewTab).toHaveBeenCalledTimes(1)
  })

  it('builds executable injection source', () => {
    const script = buildDevtoolsProjectSourceLinksScript({
      projectRoot: '/workspace/demo',
      resourceBaseUrl: 'http://127.0.0.1:5173/',
      appId: 'wxabc123',
      outputRoot: 'main',
    })

    expect(() => window.eval(script)).not.toThrow()
  })

  describe('capture-phase click interceptor redirects project links to the built-in editor', () => {
    type FrontendHost = { openInNewTab: ReturnType<typeof vi.fn> }

    function hostFn(): FrontendHost {
      return (window as typeof window & {
        Host: { InspectorFrontendHost: FrontendHost }
      }).Host.InspectorFrontendHost
    }

    function makeProjectLink(): HTMLSpanElement {
      const link = document.createElement('span')
      link.className = 'devtools-link'
      link.title = 'http://127.0.0.1:5173/pages/console-test.js:75'
      link.textContent = 'console-test.js:75'
      return link
    }

    function clickEvent(overrides: Partial<MouseEventInit> = {}): MouseEvent {
      return new MouseEvent('click', {
        button: 0,
        bubbles: true,
        cancelable: true,
        composed: true,
        ...overrides,
      })
    }

    it('redirects a plain left-click on a project-source link to openInNewTab with the 0-based sentinel and prevents default', async () => {
      inject()
      const link = makeProjectLink()
      document.body.append(link)
      await flushMutations()

      const event = clickEvent()
      link.dispatchEvent(event)

      const host = hostFn()
      expect(host.openInNewTab).toHaveBeenCalledTimes(1)
      // Display ":75" is 1-based → stored line 74; no displayed column → undefined.
      expect(host.openInNewTab).toHaveBeenCalledWith(
        encodeOpenInEditorUrl({
          url: 'http://127.0.0.1:5173/pages/console-test.js',
          line: 74,
          column: undefined,
        }),
      )
      expect(event.defaultPrevented).toBe(true)
    })

    it('decodes a displayed :line:col (1-based) into a 0-based sentinel column', async () => {
      inject()
      const link = makeProjectLink()
      link.title = 'http://127.0.0.1:5173/pages/console-test.js:75:3'
      link.textContent = 'console-test.js:75:3'
      document.body.append(link)
      await flushMutations()

      const event = clickEvent()
      link.dispatchEvent(event)

      const host = hostFn()
      expect(host.openInNewTab).toHaveBeenCalledTimes(1)
      // Display ":75:3" → stored line 74, column 2 (both 0-based).
      expect(host.openInNewTab).toHaveBeenCalledWith(
        encodeOpenInEditorUrl({
          url: 'http://127.0.0.1:5173/pages/console-test.js',
          line: 74,
          column: 2,
        }),
      )
      expect(event.defaultPrevented).toBe(true)
    })

    it('resolves the host from globalThis.InspectorFrontendHost first, with no window.Host present', async () => {
      // The existing beforeEach defines window.Host; remove it so only the
      // globalThis.InspectorFrontendHost path can satisfy the contract.
      delete (window as typeof window & { Host?: unknown }).Host
      const openInNewTab = vi.fn()
      ;(globalThis as typeof globalThis & {
        InspectorFrontendHost?: { openInNewTab: ReturnType<typeof vi.fn> }
      }).InspectorFrontendHost = { openInNewTab }
      try {
        inject()
        const link = makeProjectLink()
        document.body.append(link)
        await flushMutations()

        const event = clickEvent()
        link.dispatchEvent(event)

        expect(openInNewTab).toHaveBeenCalledTimes(1)
        expect(openInNewTab).toHaveBeenCalledWith(
          encodeOpenInEditorUrl({
            url: 'http://127.0.0.1:5173/pages/console-test.js',
            line: 74,
            column: undefined,
          }),
        )
        expect(event.defaultPrevented).toBe(true)
      }
      finally {
        delete (globalThis as typeof globalThis & { InspectorFrontendHost?: unknown })
          .InspectorFrontendHost
      }
    })

    it('does not intercept a non-project resource link (different origin); it falls through to DevTools', async () => {
      inject()
      const otherOrigin = document.createElement('span')
      otherOrigin.className = 'devtools-link'
      otherOrigin.title = 'http://localhost:9999/x.js:1'
      otherOrigin.textContent = 'x.js:1'
      document.body.append(otherOrigin)

      const nodeLink = document.createElement('span')
      nodeLink.className = 'devtools-link'
      nodeLink.title = 'node:events:5'
      nodeLink.textContent = 'events:5'
      document.body.append(nodeLink)
      await flushMutations()

      const otherEvent = clickEvent()
      otherOrigin.dispatchEvent(otherEvent)
      const nodeEvent = clickEvent()
      nodeLink.dispatchEvent(nodeEvent)

      expect(hostFn().openInNewTab).not.toHaveBeenCalled()
      expect(otherEvent.defaultPrevented).toBe(false)
      expect(nodeEvent.defaultPrevented).toBe(false)
    })

    it('does not intercept a modified click (meta/ctrl) on a project link; it falls through to DevTools', async () => {
      inject()
      const metaLink = makeProjectLink()
      document.body.append(metaLink)
      const ctrlLink = makeProjectLink()
      document.body.append(ctrlLink)
      await flushMutations()

      const metaEvent = clickEvent({ metaKey: true })
      metaLink.dispatchEvent(metaEvent)
      const ctrlEvent = clickEvent({ ctrlKey: true })
      ctrlLink.dispatchEvent(ctrlEvent)

      expect(hostFn().openInNewTab).not.toHaveBeenCalled()
      expect(metaEvent.defaultPrevented).toBe(false)
      expect(ctrlEvent.defaultPrevented).toBe(false)
    })

    it('intercepts a project link inside an open shadow root via the capture-phase document listener', async () => {
      inject()
      const shadowHost = document.createElement('div')
      const shadowRoot = shadowHost.attachShadow({ mode: 'open' })
      document.body.append(shadowHost)
      const link = makeProjectLink()
      shadowRoot.append(link)
      await flushMutations()

      const event = clickEvent()
      link.dispatchEvent(event)

      const host = hostFn()
      expect(host.openInNewTab).toHaveBeenCalledTimes(1)
      expect(host.openInNewTab).toHaveBeenCalledWith(
        encodeOpenInEditorUrl({
          url: 'http://127.0.0.1:5173/pages/console-test.js',
          line: 74,
          column: undefined,
        }),
      )
      expect(event.defaultPrevented).toBe(true)
    })
  })
})
