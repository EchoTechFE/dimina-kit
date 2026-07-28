/**
 * Companion to `use-simulator-hot-reload.test.tsx` — guards the explicit
 * relaunch (重新编译 / retry) half of the native attach effect.
 *
 * Contract under test:
 *  - `useSimulator` accepts a numeric `relaunchNonce` prop, bumped once per
 *    explicit relaunch. Unlike `hotReloadToken` (a soft reload that keeps the
 *    user on their CURRENT page), a `relaunchNonce` bump is NOT a hot reload:
 *    it hard-attaches via `attachNativeSimulator` at the configured
 *    `startPage`, resetting any page the user had drifted to.
 *  - Because `relaunchNonce` is in the attach effect's dependency array, the
 *    hard attach fires even when the resulting `simulatorUrl` is
 *    byte-identical to the one already attached — that was the bug: a
 *    relaunch back to the current startPage produced an unchanged URL, the
 *    effect never re-ran, and the simulator stayed on the drifted page.
 *  - Rerenders that change neither `relaunchNonce` nor `hotReloadToken` nor
 *    `simulatorUrl` must cause ZERO additional attach calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'

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
    // relaunchNonce bumps go through the non-hot-reload (else) branch, which
    // always hard-attaches directly — softReloadNativeSimulator is never
    // consulted on that path. Mocked here (declining) purely so an accidental
    // hot-reload classification in a future edit still falls through to the
    // hard attach these assertions check, instead of hanging on an
    // unresolved mock.
    softReloadNativeSimulator: vi.fn(async () => false),
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
 */
function makeBaseProps(): UseSimulatorProps {
  return {
    compileStatus: { status: 'ready', message: '编译完成' },
    sendDeviceInfo: vi.fn(),
    simPanelWidthRef: { current: 420 } as RefObject<number>,
    deviceRef: { current: DEVICES[1] as DeviceType } as RefObject<DeviceType>,
    appInfo: { appId: 'relaunch-app' },
    compileConfig: {
      startPage: START_PAGE,
      scene: 1011,
      queryParams: [{ key: 'foo', value: 'bar' }],
    },
    port: 7788,
    projectPath: '/tmp/relaunch-project',
    hotReloadToken: 0,
    relaunchNonce: 0,
  }
}

function renderSimulator(base: ReturnType<typeof makeBaseProps>) {
  return renderHook(
    ({ props }: { props: ReturnType<typeof makeBaseProps> }) => useSimulator(props),
    { initialProps: { props: base } },
  )
}

/**
 * Bump props and flush the microtask queue the attach effect's promise chain
 * runs in.
 */
async function rerenderFlushed(
  rerender: (arg: { props: ReturnType<typeof makeBaseProps> }) => void,
  props: ReturnType<typeof makeBaseProps>,
): Promise<void> {
  await act(async () => {
    rerender({ props })
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Decode the URL handed to the last `attachNativeSimulator` call. */
function lastAttachUrl(): string {
  const calls = attachNativeSimulatorMock.mock.calls as unknown as unknown[][]
  expect(calls.length, 'attachNativeSimulator must have been called').toBeGreaterThan(0)
  const url = calls[calls.length - 1]![0]
  expect(typeof url).toBe('string')
  return url as string
}

describe('useSimulator: relaunchNonce → forced hard re-attach at startPage', () => {
  it('attaches exactly once on mount (baseline)', () => {
    const base = makeBaseProps()
    renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    const route = parseRoute(lastAttachUrl())
    expect(route?.entry.pagePath).toBe(START_PAGE)
  })

  it('bumping ONLY relaunchNonce (token + compileConfig unchanged, simulatorUrl byte-identical) still forces exactly one additional hard attach', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    const initialUrl = lastAttachUrl()
    attachNativeSimulatorMock.mockClear()

    await rerenderFlushed(rerender, { ...base, relaunchNonce: 1 })

    expect(
      attachNativeSimulatorMock,
      'a relaunchNonce bump must force a fresh hard attach even when the URL is unchanged',
    ).toHaveBeenCalledTimes(1)
    // Same boot target as the mount attach — the regression was that this
    // identical-URL case silently skipped the attach call altogether.
    expect(lastAttachUrl()).toBe(initialUrl)
  })

  it('relaunching after the user drifted to another page resets to startPage, not the drifted page', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)

    // User navigated in-app: main pushes the active page route.
    act(() => {
      emitCurrentPage(OTHER_PAGE)
    })
    attachNativeSimulatorMock.mockClear()

    // Explicit relaunch (重新编译 / retry) — must reset to startPage, unlike a
    // hotReloadToken bump which would keep the drifted OTHER_PAGE.
    await rerenderFlushed(rerender, { ...base, relaunchNonce: 1 })

    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    const route = parseRoute(lastAttachUrl())
    expect(route, 're-attach URL must be a parseable simulator route').not.toBeNull()
    expect(route!.entry.pagePath).toBe(START_PAGE)
    expect(route!.current.pagePath).toBe(START_PAGE)
  })

  it('a rerender that changes neither relaunchNonce, hotReloadToken, nor simulatorUrl causes zero additional attach calls', () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)

    rerender({ props: { ...base } })
    rerender({ props: { ...base, compileStatus: { status: 'ready', message: '编译完成，已重启' } } })
    rerender({ props: { ...base } })

    expect(
      attachNativeSimulatorMock,
      'no relaunchNonce/hotReloadToken/simulatorUrl change → no re-attach',
    ).toHaveBeenCalledTimes(1)
  })
})
