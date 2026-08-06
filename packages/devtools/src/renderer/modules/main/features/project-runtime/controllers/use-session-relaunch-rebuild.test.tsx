/**
 * The popover "重新编译" button drives `useSession().relaunch()`. Today
 * `relaunch` only saves the compile config and bumps `relaunchNonce` — it
 * never asks main to actually recompile, so with autoBuild off (or a dead
 * watcher) the button re-attaches the simulator to whatever was compiled
 * before, silently dropping any edit made since.
 *
 * Contract under test:
 *  - `relaunch` calls the new `rebuildProject()` IPC wrapper (from
 *    `@/shared/api`) BEFORE bumping `relaunchNonce` — the hard re-attach must
 *    reflect a build that actually ran, not race ahead of it.
 *  - `rebuildProject()` rejecting (a real compile failure) must turn
 *    `compileStatus` into `{ status: 'error', ... }` and leave
 *    `relaunchNonce` UNCHANGED — the simulator keeps its current (working)
 *    session instead of hard-resetting onto a build that doesn't exist.
 *  - `rebuildProject()` resolving with `{ supported: false }` (a host adapter
 *    that never implemented a real recompile) degrades to the pre-existing
 *    behavior: bump `relaunchNonce` anyway, exactly like before this feature.
 *
 * Pattern lifted from use-session-hot-reload.test.tsx (hoisted `@/shared/api`
 * mock, renderHook + waitFor for the initial ready state).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SessionHookResult } from './use-session'

const { rebuildProjectMock, saveCompileConfigMock } = vi.hoisted(() => ({
  rebuildProjectMock: vi.fn(async (): Promise<unknown> => undefined),
  saveCompileConfigMock: vi.fn(async () => {}),
}))

vi.mock('@/shared/api', () => {
  return {
    openProject: vi.fn(async () => ({
      success: true,
      appInfo: { appId: 'rebuild-relaunch-app' },
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
    saveCompileConfig: saveCompileConfigMock,
    onSessionRuntimeStatus: vi.fn(() => () => {}),
    onProjectStatus: vi.fn(() => () => {}),
    onCompileLog: vi.fn(() => () => {}),
    rebuildProject: rebuildProjectMock,
  }
})

import { useSession } from './use-session'

beforeEach(() => {
  rebuildProjectMock.mockClear()
  rebuildProjectMock.mockImplementation(async () => undefined)
  saveCompileConfigMock.mockClear()
})

async function renderReadySession() {
  const rendered = renderHook(() => useSession({ projectPath: '/tmp/rebuild-relaunch-project' }))
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

function readNonce(session: SessionHookResult): number {
  return session.relaunchNonce
}

describe('useSession.relaunch(): recompiles through rebuildProject before hard-resetting the simulator', () => {
  it('calls rebuildProject() before bumping relaunchNonce — the reset must not race ahead of the build', async () => {
    let releaseRebuild: () => void = () => {}
    rebuildProjectMock.mockImplementation(
      () => new Promise((resolve) => { releaseRebuild = () => resolve(undefined) }),
    )
    const { result } = await renderReadySession()
    const nonceBefore = readNonce(result.current)

    let relaunchDone = false
    act(() => {
      void result.current.relaunch().then(() => { relaunchDone = true })
    })

    await waitFor(() => expect(rebuildProjectMock).toHaveBeenCalledTimes(1))
    expect(
      readNonce(result.current),
      'the build is still in flight — relaunchNonce must not bump before rebuildProject resolves',
    ).toBe(nonceBefore)
    expect(relaunchDone).toBe(false)

    await act(async () => {
      releaseRebuild()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(readNonce(result.current)).toBe(nonceBefore + 1))
  })

  it('a rejecting rebuildProject sets compileStatus to error and leaves relaunchNonce unchanged', async () => {
    rebuildProjectMock.mockImplementation(async () => {
      throw new Error('compile failed: unexpected token')
    })
    const { result } = await renderReadySession()
    const nonceBefore = readNonce(result.current)

    await act(async () => {
      await result.current.relaunch()
    })

    expect(
      result.current.compileStatus.status,
      'a real compile failure during relaunch must surface as a compileStatus error',
    ).toBe('error')
    expect(
      readNonce(result.current),
      'a failed rebuild must NOT hard-reset the simulator — it keeps its current, still-working session',
    ).toBe(nonceBefore)
  })

  it('publishes a newly selected startPage before bumping relaunchNonce', async () => {
    const nextConfig = {
      startPage: 'pages/cart/cart',
      scene: 1001,
      queryParams: [{ key: 'from', value: 'compile-mode' }],
    }
    const { result } = await renderReadySession()
    const nonceBefore = readNonce(result.current)

    await act(async () => {
      await result.current.relaunch(nextConfig)
    })

    expect(saveCompileConfigMock).toHaveBeenCalledWith(
      '/tmp/rebuild-relaunch-project',
      nextConfig,
    )
    expect(result.current.compileConfig).toEqual(nextConfig)
    expect(readNonce(result.current)).toBe(nonceBefore + 1)
  })

  it('rebuildProject resolving { supported: false } degrades to the legacy bump-only relaunch', async () => {
    rebuildProjectMock.mockImplementation(async () => ({ supported: false }))
    const { result } = await renderReadySession()
    const nonceBefore = readNonce(result.current)

    await act(async () => {
      await result.current.relaunch()
    })

    expect(rebuildProjectMock).toHaveBeenCalledTimes(1)
    expect(
      readNonce(result.current),
      'an adapter without real rebuild support must still hard-reset via the legacy path',
    ).toBe(nonceBefore + 1)
    expect(result.current.compileStatus.status).toBe('ready')
  })
})
