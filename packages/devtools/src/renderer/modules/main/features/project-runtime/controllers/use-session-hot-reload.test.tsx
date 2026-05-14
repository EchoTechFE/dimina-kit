/**
 * TDD-style failing tests for the renderer side of the auto-reload fix.
 *
 * Contract under test (NOT yet implemented):
 *  - `ProjectStatus` will gain an optional `hotReload?: boolean`.
 *  - `use-session.ts`'s `onProjectStatus` subscription must call
 *    `simulatorRef.current.reload()` (the `WebviewLike.reload()` method
 *    exposed by `webview-helpers.ts`) whenever a status payload arrives with
 *    `hotReload === true`.
 *  - Status payloads WITHOUT `hotReload` (e.g. the initial `compiling` →
 *    `编译完成` sequence) must NOT trigger a reload.
 *
 * The implementation today only calls `setCompileStatus(data)` inside
 * `onProjectStatus`, so these assertions will fail until the implementer
 * threads `hotReload` through and adds the `webview.reload()` call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import type { RefObject } from 'react'

// ── Module mocks ─────────────────────────────────────────────────────────
//
// `use-session.ts` imports a handful of typed IPC helpers from `@/shared/api`.
// We mock the module so the hook can be exercised without a preload bridge,
// and so the test can drive the projectStatus listener manually.

// The `onProjectStatus` mock captures the latest listener so the test can
// invoke it as if the main process had sent a payload.
const projectStatusListeners: Array<(s: unknown) => void> = []
function emitProjectStatus(payload: {
  status: string
  message: string
  hotReload?: boolean
}): void {
  for (const fn of [...projectStatusListeners]) fn(payload)
}

vi.mock('@/shared/api', () => {
  return {
    openProject: vi.fn(async () => ({
      success: true,
      appInfo: { appId: 'fake' },
      port: 12345,
    })),
    getProjectPages: vi.fn(async () => ({
      pages: ['pages/index/index'],
      entryPagePath: 'pages/index/index',
    })),
    getCompileConfig: vi.fn(async () => ({
      startPage: 'pages/index/index',
      scene: 1011,
      queryParams: [],
    })),
    saveCompileConfig: vi.fn(async () => {}),
    getPreloadPath: vi.fn(async () => '/tmp/preload.js'),
    onProjectStatus: vi.fn((handler: (s: unknown) => void) => {
      projectStatusListeners.push(handler)
      return () => {
        const i = projectStatusListeners.indexOf(handler)
        if (i >= 0) projectStatusListeners.splice(i, 1)
      }
    }),
  }
})

// ── Lazy import the hook AFTER the @/shared/api mock is in place. ────────
type UseSession = typeof import('./use-session').useSession
let useSession: UseSession

beforeEach(async () => {
  projectStatusListeners.length = 0
  vi.resetModules()
  ;({ useSession } = await import('./use-session'))
})

// Shape of the webview/simulator ref used by the hook. We only care about
// `.reload`; everything else is best-effort.
type FakeWebview = {
  reload: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function makeFakeWebview(currentUrl = ''): FakeWebview {
  return {
    reload: vi.fn(),
    getURL: vi.fn(() => currentUrl),
    loadURL: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

/**
 * Render the hook with a ref pre-populated with our fake webview. The hook
 * accepts `RefObject<HTMLElement | null>`; the fake is structurally compatible
 * with the `WebviewLike` shape consumed via `asWebview`.
 */
function renderUseSession(fakeWebview: FakeWebview) {
  return renderHook(() => {
    const simulatorRef = useRef<HTMLElement | null>(
      fakeWebview as unknown as HTMLElement,
    )
    return useSession({
      projectPath: '/tmp/fakeProj',
      simulatorRef: simulatorRef as RefObject<HTMLElement | null>,
    })
  })
}

describe('useSession: hotReload signal → reload simulator webview', () => {
  it('calls simulatorRef.current.reload() when projectStatus arrives with hotReload:true', async () => {
    const webview = makeFakeWebview()
    const hook = renderUseSession(webview)

    // Wait for the initial openProject load to settle so listeners are
    // registered and subsequent reload calls aren't masked by mount flicker.
    await waitFor(() => {
      expect(hook.result.current.appInfo?.appId).toBe('fake')
    })

    const reloadCallsBefore = webview.reload.mock.calls.length

    act(() => {
      emitProjectStatus({
        status: 'ready',
        message: '编译完成，已热更新',
        hotReload: true,
      })
    })

    expect(
      webview.reload.mock.calls.length - reloadCallsBefore,
      'expected exactly one webview.reload() call in response to hotReload:true status',
    ).toBe(1)
  })

  it('does NOT call reload when projectStatus arrives WITHOUT hotReload', async () => {
    const webview = makeFakeWebview()
    const hook = renderUseSession(webview)

    await waitFor(() => {
      expect(hook.result.current.appInfo?.appId).toBe('fake')
    })

    const reloadCallsBefore = webview.reload.mock.calls.length

    // Send a status that DOES NOT mark hotReload — this is the initial-open
    // “编译完成” flow on the main side. The renderer must leave the iframe
    // alone (otherwise the page would reload on every status update).
    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成' })
    })

    expect(
      webview.reload.mock.calls.length - reloadCallsBefore,
      'expected NO webview.reload() call for status without hotReload',
    ).toBe(0)
  })
})

describe('useSession: hotReload collapses stacked hash before reload', () => {
  it('stacked URL → loadURL with collapsed hash, then reload', async () => {
    vi.useFakeTimers()
    try {
      const stackedUrl =
        'http://localhost:1000/simulator.html#wx|pages/a/a|pages/b/b?scene=1001'
      const collapsedUrl =
        'http://localhost:1000/simulator.html#wx|pages/b/b?scene=1001'

      const webview = makeFakeWebview(stackedUrl)
      const hook = renderUseSession(webview)

      // Drain the initial async load (openProject + getProjectPages + ...).
      await vi.waitFor(() => {
        expect(hook.result.current.appInfo?.appId).toBe('fake')
      })

      const loadUrlCallsBefore = webview.loadURL.mock.calls.length
      const reloadCallsBefore = webview.reload.mock.calls.length

      act(() => {
        emitProjectStatus({
          status: 'ready',
          message: '编译完成，已热更新',
          hotReload: true,
        })
      })

      // loadURL fires synchronously with the collapsed URL.
      expect(
        webview.loadURL.mock.calls.length - loadUrlCallsBefore,
        'expected exactly one webview.loadURL() call with the collapsed hash',
      ).toBe(1)
      expect(webview.loadURL).toHaveBeenLastCalledWith(collapsedUrl)

      // reload runs ~100ms later. Advance fake timers past the gap.
      act(() => {
        vi.advanceTimersByTime(200)
      })

      expect(
        webview.reload.mock.calls.length - reloadCallsBefore,
        'expected exactly one webview.reload() call after the loadURL gap',
      ).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('single-page URL → reload only, no loadURL', async () => {
    const singleUrl =
      'http://localhost:1000/simulator.html#wx|pages/a/a?scene=1001'

    const webview = makeFakeWebview(singleUrl)
    const hook = renderUseSession(webview)

    await waitFor(() => {
      expect(hook.result.current.appInfo?.appId).toBe('fake')
    })

    const loadUrlCallsBefore = webview.loadURL.mock.calls.length
    const reloadCallsBefore = webview.reload.mock.calls.length

    act(() => {
      emitProjectStatus({
        status: 'ready',
        message: '编译完成，已热更新',
        hotReload: true,
      })
    })

    expect(
      webview.reload.mock.calls.length - reloadCallsBefore,
      'expected exactly one webview.reload() for single-page hash',
    ).toBe(1)
    expect(
      webview.loadURL.mock.calls.length - loadUrlCallsBefore,
      'expected NO webview.loadURL() call for single-page hash',
    ).toBe(0)
  })
})
