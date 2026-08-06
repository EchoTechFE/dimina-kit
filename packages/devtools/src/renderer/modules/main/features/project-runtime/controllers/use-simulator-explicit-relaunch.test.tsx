/**
 * Companion to use-simulator-hot-reload.test.tsx / use-simulator-soft-reload.test.tsx
 * / use-simulator-force-relaunch.test.tsx — guards the case where an explicit
 * relaunch (重新编译, bumping `relaunchNonce`) and a watcher hot-reload signal
 * (bumping `hotReloadToken`) land in the SAME attach-effect run, e.g. because
 * `session.rebuild()`'s completed build both satisfies the explicit request
 * and is reported through the same `hotReloadToken` plumbing the watcher
 * uses.
 *
 * Contract under test:
 *  - When BOTH `relaunchNonce` and `hotReloadToken` changed since the attach
 *    effect last ran, the explicit relaunch must win: the hook hard-attaches
 *    via `attachNativeSimulator` and must NEVER consult
 *    `softReloadNativeSimulator` first. A user-requested rebuild must not be
 *    downgraded into a soft in-place reload, and must not race a soft reload
 *    against the hard re-attach it is entitled to.
 *  - This is a REGRESSION relative to the sibling soft-reload test file: today
 *    `isHotReload` is decided purely by `hotReloadToken !== ref` — a
 *    simultaneous nonce bump does not override it, so the hook takes the
 *    soft-reload-first branch instead of hard-attaching directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'

// vi.mock factories are hoisted above module-level consts, so shared mock
// state must be created via vi.hoisted to avoid a TDZ crash.
const { attachNativeSimulatorMock, softReloadNativeSimulatorMock } = vi.hoisted(() => ({
  attachNativeSimulatorMock: vi.fn(async (..._args: unknown[]) => {}),
  softReloadNativeSimulatorMock: vi.fn(async (..._args: unknown[]) => true as boolean | undefined),
}))

vi.mock('@/shared/api', () => {
  return {
    attachNativeSimulator: attachNativeSimulatorMock,
    softReloadNativeSimulator: softReloadNativeSimulatorMock,
    captureThumbnail: vi.fn(async () => null),
    onSimulatorCurrentPage: vi.fn(() => () => {}),
  }
})

import { useSimulator } from './use-simulator'
import type { UseSimulatorProps } from './use-simulator'
import { parseRoute } from '../../../../../../shared/simulator-route'
import { DEVICES } from '@/shared/constants'
import type { DeviceType } from './use-project-runtime-controller'

beforeEach(() => {
  attachNativeSimulatorMock.mockClear()
  softReloadNativeSimulatorMock.mockClear()
  // Soft reload "succeeds" by default in this file — if the hook incorrectly
  // takes the soft-reload branch, attachNativeSimulator will never be called
  // at all, making the misrouting obvious instead of being masked by a
  // hard-attach fallback after a resolved(false).
  softReloadNativeSimulatorMock.mockResolvedValue(true)
})

const START_PAGE = 'pages/index/index'

function makeBaseProps(): UseSimulatorProps {
  return {
    compileStatus: { status: 'ready', message: '编译完成' },
    sendDeviceInfo: vi.fn(),
    simPanelWidthRef: { current: 420 } as RefObject<number>,
    deviceRef: { current: DEVICES[1] as DeviceType } as RefObject<DeviceType>,
    appInfo: { appId: 'explicit-relaunch-app' },
    compileConfig: {
      startPage: START_PAGE,
      scene: 1011,
      queryParams: [],
    },
    port: 7788,
    projectPath: '/tmp/explicit-relaunch-project',
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

async function rerenderFlushed(rerender: Rerender, props: UseSimulatorProps): Promise<void> {
  await act(async () => {
    rerender({ props })
    await Promise.resolve()
    await Promise.resolve()
  })
}

function lastAttachUrl(): string {
  const calls = attachNativeSimulatorMock.mock.calls as unknown as unknown[][]
  expect(calls.length, 'attachNativeSimulator must have been called').toBeGreaterThan(0)
  const url = calls[calls.length - 1]![0]
  expect(typeof url).toBe('string')
  return url as string
}

describe('useSimulator: an explicit relaunch bumped together with hotReloadToken forces a hard re-attach', () => {
  it('bumping BOTH relaunchNonce and hotReloadToken in one effect run never calls softReloadNativeSimulator', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    attachNativeSimulatorMock.mockClear()

    await rerenderFlushed(rerender, { ...base, relaunchNonce: 1, hotReloadToken: 1 })

    expect(
      softReloadNativeSimulatorMock,
      'an explicit relaunch (session.rebuild() completing) must never be treated as a soft hot-reload, even though hotReloadToken also bumped in the same run',
    ).not.toHaveBeenCalled()
  })

  it('bumping BOTH relaunchNonce and hotReloadToken in one effect run hard-attaches exactly once', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    expect(attachNativeSimulatorMock).toHaveBeenCalledTimes(1)
    attachNativeSimulatorMock.mockClear()

    await rerenderFlushed(rerender, { ...base, relaunchNonce: 1, hotReloadToken: 1 })

    expect(
      attachNativeSimulatorMock,
      'the explicit relaunch must hard re-attach directly — today the simultaneous hotReloadToken bump routes through softReloadNativeSimulator instead, and this mock resolves true, so a misrouted call never falls back to attachNativeSimulator at all',
    ).toHaveBeenCalledTimes(1)
  })

  it('the simultaneous-bump hard re-attach resets to startPage, not a soft in-place reload of the current page', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    attachNativeSimulatorMock.mockClear()

    await rerenderFlushed(rerender, { ...base, relaunchNonce: 1, hotReloadToken: 1 })

    const route = parseRoute(lastAttachUrl())
    expect(route, 're-attach URL must be a parseable simulator route').not.toBeNull()
    expect(route!.entry.pagePath).toBe(START_PAGE)
  })

  it('a rerender bumping ONLY hotReloadToken (nonce unchanged) still consults softReloadNativeSimulator first (unchanged sibling behavior)', async () => {
    const base = makeBaseProps()
    const { rerender } = renderSimulator(base)
    attachNativeSimulatorMock.mockClear()

    await rerenderFlushed(rerender, { ...base, hotReloadToken: 1 })

    expect(
      softReloadNativeSimulatorMock,
      'a lone hotReloadToken bump is a background hot-reload and must still try the soft path first',
    ).toHaveBeenCalledTimes(1)
  })
})
