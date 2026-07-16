/**
 * Companion to `use-simulator-hot-reload.test.tsx` — the soft-before-hard
 * fallback for the hot-reload attach path.
 *
 * Contract under test:
 *  - The INITIAL mount attach (not a hot reload) never calls
 *    `softReloadNativeSimulator` — it calls `attachNativeSimulator` directly,
 *    same as before this feature.
 *  - A `hotReloadToken` bump first calls `softReloadNativeSimulator(attachUrl)`
 *    with the same URL the hot-reload attach would otherwise use (current-page
 *    respawn URL, per the sibling hot-reload test).
 *  - When `softReloadNativeSimulator` resolves `true` (the DeviceShell soft
 *    reloaded in place), `attachNativeSimulator` must NOT be called — no hard
 *    rebuild on top of a successful soft one.
 *  - When it resolves `false` or `undefined` (soft reload unsupported/failed),
 *    the hook falls back to `attachNativeSimulator(attachUrl, …)` — the
 *    hard-rebuild behavior — with the SAME url.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'

// vi.mock factories are hoisted above module-level consts, so shared mock
// state must be created via vi.hoisted to avoid a TDZ crash.
const { currentPageListeners, attachNativeSimulatorMock, softReloadNativeSimulatorMock } = vi.hoisted(() => ({
  currentPageListeners: [] as Array<(pagePath: string) => void>,
  attachNativeSimulatorMock: vi.fn(async (..._args: unknown[]) => {}),
  softReloadNativeSimulatorMock: vi.fn(async (..._args: unknown[]) => false as boolean | undefined),
}))

function emitCurrentPage(pagePath: string): void {
  for (const fn of [...currentPageListeners]) fn(pagePath)
}

// vi.mock replaces the whole '@/shared/api' module with this factory, so
// the real module's current exports are irrelevant here.
vi.mock('@/shared/api', () => {
  return {
    attachNativeSimulator: attachNativeSimulatorMock,
    softReloadNativeSimulator: softReloadNativeSimulatorMock,
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
  softReloadNativeSimulatorMock.mockClear()
  softReloadNativeSimulatorMock.mockResolvedValue(false)
})

// ── Fixtures ─────────────────────────────────────────────────────────────

const START_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/storage-test/storage-test'

function makeBaseProps(): UseSimulatorProps {
  return {
    compileStatus: { status: 'ready', message: '编译完成' },
    sendDeviceInfo: vi.fn(),
    simPanelWidthRef: { current: 420 } as RefObject<number>,
    deviceRef: { current: DEVICES[1] as DeviceType } as RefObject<DeviceType>,
    appInfo: { appId: 'soft-reload-app' },
    compileConfig: {
      startPage: START_PAGE,
      scene: 1011,
      queryParams: [{ key: 'foo', value: 'bar' }],
    },
    port: 7788,
    projectPath: '/tmp/soft-reload-project',
    hotReloadToken: 0,
    relaunchNonce: 0,
  }
}

function renderSimulator(base: UseSimulatorProps) {
  return renderHook(
    ({ props }: { props: UseSimulatorProps }) => useSimulator(props),
    { initialProps: { props: base } },
  )
}

type Rerender = (arg: { props: UseSimulatorProps }) => void

/** Bump the token and flush the microtask the softReload decision runs in. */
async function rerenderWithToken(rerender: Rerender, base: UseSimulatorProps, token: number): Promise<void> {
  await act(async () => {
    rerender({ props: { ...base, hotReloadToken: token } })
    await Promise.resolve()
    await Promise.resolve()
  })
}

function lastCallUrl(mock: typeof attachNativeSimulatorMock | typeof softReloadNativeSimulatorMock): string {
  const calls = mock.mock.calls as unknown as unknown[][]
  expect(calls.length, 'expected at least one call').toBeGreaterThan(0)
  const url = calls[calls.length - 1]![0]
  expect(typeof url).toBe('string')
  return url as string
}

describe('useSimulator: soft-reload-then-hard-fallback on hotReloadToken bump', () => {
  it('the initial mount attach never calls softReloadNativeSimulator', () => {
    const base = makeBaseProps()
    renderSimulator(base)

    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    expect(softReloadNativeSimulatorMock).not.toHaveBeenCalled()
  })

  it('a token bump calls softReloadNativeSimulator with the current-page attach URL', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    act(() => { emitCurrentPage(OTHER_PAGE) })
    attachNativeSimulatorMock.mockClear()

    await rerenderWithToken(rerender, base, 1)

    expect(softReloadNativeSimulatorMock).toHaveBeenCalledTimes(1)
    const route = parseRoute(lastCallUrl(softReloadNativeSimulatorMock))
    expect(route?.entry.pagePath).toBe(OTHER_PAGE)
  })

  it('when softReloadNativeSimulator resolves true, attachNativeSimulator is NOT called', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    attachNativeSimulatorMock.mockClear()
    softReloadNativeSimulatorMock.mockResolvedValueOnce(true)

    await rerenderWithToken(rerender, base, 1)

    expect(softReloadNativeSimulatorMock).toHaveBeenCalledTimes(1)
    expect(
      attachNativeSimulatorMock,
      'a successful soft reload must not also hard-rebuild',
    ).not.toHaveBeenCalled()
  })

  it('when softReloadNativeSimulator resolves false, falls back to attachNativeSimulator with the same URL', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    attachNativeSimulatorMock.mockClear()
    softReloadNativeSimulatorMock.mockResolvedValueOnce(false)

    await rerenderWithToken(rerender, base, 1)

    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    expect(lastCallUrl(attachNativeSimulatorMock)).toBe(lastCallUrl(softReloadNativeSimulatorMock))
  })

  it('when softReloadNativeSimulator resolves undefined, falls back to attachNativeSimulator', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    attachNativeSimulatorMock.mockClear()
    softReloadNativeSimulatorMock.mockResolvedValueOnce(undefined)

    await rerenderWithToken(rerender, base, 1)

    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
  })
})
