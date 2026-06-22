/**
 * Companion to `use-session-hot-reload.test.tsx` — the simulator half of the
 * resurrected PR #12 hot-reload guard (deleted in PR #39 / a85fb6dc without a
 * native-host replacement).
 *
 * Contract under test (TDD — NOT yet implemented):
 *  - `useSimulator` accepts a numeric `hotReloadToken` prop (threaded from
 *    `useSession` via `use-project-runtime-controller`).
 *  - A token bump re-runs the native attach effect EXACTLY once:
 *    `attachNativeSimulator` is invoked again, which (in main) tears down and
 *    respawns the DeviceShell — that is the native-host reload primitive
 *    (view-manager.ts attachNativeSimulator).
 *  - The re-attach URL keeps the user on their CURRENT page (the
 *    `onSimulatorCurrentPage` mirror), not the original startPage — the
 *    native equivalent of the old `collapseRouteToTopPage` semantics.
 *  - When the current page differs from the configured startPage, the
 *    startPage's `queryParams` must NOT leak onto the new entry (those params
 *    belong to the startPage only).
 *  - Rerenders WITHOUT a token change must cause ZERO additional attach calls
 *    (no attach storms — rebuilds before/after leave status 'ready' and the
 *    simulatorUrl unchanged, so today the effect never re-runs; after the fix
 *    it must re-run on token changes ONLY).
 *
 * Today `useSimulator` ignores the extra prop entirely (its attach effect
 * depends only on [compileStatus.status, simulatorUrl, refs]), so the
 * re-attach assertions fail — that is the intended red state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'

// ── Module mocks ─────────────────────────────────────────────────────────

// vi.mock factories are hoisted above module-level consts, so shared mock
// state must be created via vi.hoisted to avoid a TDZ crash.
const { currentPageListeners, attachNativeSimulatorMock } = vi.hoisted(() => ({
  currentPageListeners: [] as Array<(pagePath: string) => void>,
  attachNativeSimulatorMock: vi.fn(async (..._args: unknown[]) => {}),
}))

function emitCurrentPage(pagePath: string): void {
  for (const fn of [...currentPageListeners]) fn(pagePath)
}

vi.mock('@/shared/api', () => {
  return {
    attachNativeSimulator: attachNativeSimulatorMock,
    captureThumbnail: vi.fn(async () => null),
    onSimulatorCurrentPage: vi.fn((handler: (pagePath: string) => void) => {
      currentPageListeners.push(handler)
      return () => {
        const i = currentPageListeners.indexOf(handler)
        if (i >= 0) currentPageListeners.splice(i, 1)
      }
    }),
  }
})

import { useSimulator } from './use-simulator'
import type { UseSimulatorProps } from './use-simulator'
import { parseRoute } from '../../../../../../shared/simulator-route'
import { DEVICES } from '@/shared/constants'
import type { DeviceType } from './use-project-runtime-controller'

beforeEach(() => {
  currentPageListeners.length = 0
  attachNativeSimulatorMock.mockClear()
})

// ── Fixtures ─────────────────────────────────────────────────────────────

const START_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/storage-test/storage-test'

/**
 * Build a stable props bag. Ref/function identities are created once per
 * test (via this factory's return) and reused across rerenders, mirroring
 * how `use-project-runtime-controller` passes stable refs/callbacks down.
 *
 * `hotReloadToken` is part of the NEW contract — it does not exist on
 * `UseSimulatorProps` yet, hence the structural cast.
 */
function makeBaseProps(): UseSimulatorProps & { hotReloadToken: number } {
  return {
    compileStatus: { status: 'ready', message: '编译完成' },
    sendDeviceInfo: vi.fn(),
    simPanelWidthRef: { current: 420 } as RefObject<number>,
    deviceRef: { current: DEVICES[1] as DeviceType } as RefObject<DeviceType>,
    appInfo: { appId: 'hot-reload-app' },
    compileConfig: {
      startPage: START_PAGE,
      scene: 1011,
      // Start-page-only params — must NOT survive a reload onto another page.
      queryParams: [{ key: 'foo', value: 'bar' }],
    },
    port: 7788,
    projectPath: '/tmp/hot-reload-project',
    hotReloadToken: 0,
  }
}

function renderSimulator(base: ReturnType<typeof makeBaseProps>) {
  return renderHook(
    ({ props }: { props: ReturnType<typeof makeBaseProps> }) =>
      useSimulator(props as UseSimulatorProps),
    { initialProps: { props: base } },
  )
}

/** Decode the URL handed to the last `attachNativeSimulator` call. */
function lastAttachUrl(): string {
  const calls = attachNativeSimulatorMock.mock.calls as unknown as unknown[][]
  expect(calls.length, 'attachNativeSimulator must have been called').toBeGreaterThan(0)
  const url = calls[calls.length - 1]![0]
  expect(typeof url).toBe('string')
  return url as string
}

describe('useSimulator: hotReloadToken → native re-attach (resurrected PR#12 guard, deleted in PR#39)', () => {
  it('attaches exactly once on mount (baseline)', () => {
    const base = makeBaseProps()
    renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    const route = parseRoute(lastAttachUrl())
    expect(route?.entry.pagePath).toBe(START_PAGE)
  })

  it('rerenders with an unchanged token cause ZERO additional attach calls (no attach storm)', () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)

    // Fresh object identities but identical values — exactly what a parent
    // re-render produces. Status flapping through 'ready' repeatedly (e.g.
    // rebuild notifications) must not re-attach without a token change.
    rerender({ props: { ...base } })
    rerender({ props: { ...base, compileStatus: { status: 'ready', message: '编译完成，已热更新' } } })
    rerender({ props: { ...base } })

    expect(
      attachNativeSimulatorMock,
      'no token change → no re-attach',
    ).toHaveBeenCalledTimes(1)
  })

  it('a token bump re-attaches EXACTLY once, at the current page, without the startPage queryParams', () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)

    // User navigated in-app: main pushes the active page route.
    act(() => {
      emitCurrentPage(OTHER_PAGE)
    })
    attachNativeSimulatorMock.mockClear()

    // Watcher rebuild completed → session bumps the token.
    rerender({ props: { ...base, hotReloadToken: 1 } })

    expect(
      attachNativeSimulatorMock,
      'a hotReloadToken bump must trigger exactly one DeviceShell respawn',
    ).toHaveBeenCalledTimes(1)

    const route = parseRoute(lastAttachUrl())
    expect(route, 're-attach URL must be a parseable simulator route').not.toBeNull()
    // Reload keeps the user on their current page (old collapse-to-top-page
    // semantics: respawn boots at the page they were looking at).
    expect(route!.entry.pagePath).toBe(OTHER_PAGE)
    expect(route!.current.pagePath).toBe(OTHER_PAGE)
    // The startPage-specific queryParams must not leak onto another page.
    expect(route!.entry.query).not.toHaveProperty('foo')
  })

  it('a token bump with no prior navigation re-attaches at the startPage with its queryParams intact', () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    const initialUrl = lastAttachUrl()
    attachNativeSimulatorMock.mockClear()

    rerender({ props: { ...base, hotReloadToken: 1 } })

    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    const route = parseRoute(lastAttachUrl())
    expect(route!.entry.pagePath).toBe(START_PAGE)
    // currentPage === startPage → this IS the start page; its params stay.
    expect(route!.entry.query).toMatchObject({ foo: 'bar' })
    // Equivalent boot target as the original mount.
    expect(lastAttachUrl()).toBe(initialUrl)
  })

  it('repeated rerenders at the SAME bumped token value re-attach only once', () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    attachNativeSimulatorMock.mockClear()

    rerender({ props: { ...base, hotReloadToken: 1 } })
    rerender({ props: { ...base, hotReloadToken: 1 } })
    rerender({ props: { ...base, hotReloadToken: 1 } })

    expect(
      attachNativeSimulatorMock,
      'a token value is one reload; rerenders at the same value must not re-attach again',
    ).toHaveBeenCalledTimes(1)
  })

  it('each successive token bump re-attaches once more (N rebuilds → N reloads)', () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    attachNativeSimulatorMock.mockClear()

    rerender({ props: { ...base, hotReloadToken: 1 } })
    rerender({ props: { ...base, hotReloadToken: 2 } })

    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(2)
  })
})
