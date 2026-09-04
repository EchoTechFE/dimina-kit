/**
 * The toolbar's 重新编译 button drives `useSession().relaunch()`. A relaunch
 * that only bumped `relaunchNonce` would re-attach the simulator to whatever
 * was compiled before, silently dropping any edit made since.
 *
 * Contract under test:
 *  - `relaunch` calls the new `rebuildProject()` IPC wrapper (from
 *    `@/shared/api`) BEFORE bumping `relaunchNonce` — the hard re-attach must
 *    reflect a build that actually ran, not race ahead of it.
 *  - While that rebuild is in flight, `compileStatus` stays non-ready so
 *    `useSimulator` cannot attach stale or partially written output.
 *  - `rebuildProject()` rejecting (a real compile failure) must turn
 *    `compileStatus` into `{ status: 'error', ... }` and leave
 *    `relaunchNonce` UNCHANGED — the simulator keeps its current (working)
 *    session instead of hard-resetting onto a build that doesn't exist.
 *  - `rebuildProject()` resolving with `{ supported: false }` (a host adapter
 *    that never implemented a real recompile) degrades to the pre-existing
 *    behavior: bump `relaunchNonce` anyway, exactly like before this feature.
 *
 * A `CompileModeStore` push with `relaunch: true` drives this same
 * `relaunch()` (see `relaunchRef` in use-session.ts). Whether that push
 * itself gets adopted and calls `rebuildProject()` once is pinned in
 * use-session-compile-mode-state.test.tsx; this file only owns the
 * rebuild-vs-relaunchNonce ordering/error semantics above, plus the one test
 * below that also has to check what the push chain does downstream of
 * rebuildProject (relaunchNonce, compileConfig) — not just that it fires.
 *
 * Pattern lifted from use-session-hot-reload.test.tsx (hoisted `@/shared/api`
 * mock, renderHook + waitFor for the initial ready state).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SessionHookResult } from './use-session'

interface FakeCompileModeState {
  selectedId: string | null
  entries: Array<{ id: string; mode: { name: string; pathName: string; query: string; scene: number | null } }>
}
interface FakeChange {
  revision: number
  state: FakeCompileModeState
  relaunch: boolean
}

const { rebuildProjectMock, changeListeners } = vi.hoisted(() => ({
  rebuildProjectMock: vi.fn(async (): Promise<unknown> => undefined),
  changeListeners: [] as Array<(change: FakeChange) => void>,
}))

function emitCompileModesChanged(change: FakeChange): void {
  for (const fn of [...changeListeners]) fn(change)
}

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
    getCompileModeState: vi.fn(async () => ({
      revision: 1,
      state: { selectedId: null, entries: [] },
      relaunch: false,
    })),
    onCompileModesChanged: vi.fn((handler: (change: FakeChange) => void) => {
      changeListeners.push(handler)
      return () => {
        const idx = changeListeners.indexOf(handler)
        if (idx >= 0) changeListeners.splice(idx, 1)
      }
    }),
    onCompileModesApplyFailed: vi.fn(() => () => {}),
    onSessionRuntimeStatus: vi.fn(() => () => {}),
    onProjectStatus: vi.fn(() => () => {}),
    onCompileLog: vi.fn(() => () => {}),
    rebuildProject: rebuildProjectMock,
  }
})

import { useSession } from './use-session'

beforeEach(() => {
  changeListeners.length = 0
  rebuildProjectMock.mockClear()
  rebuildProjectMock.mockImplementation(async () => undefined)
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
    expect(
      result.current.compileStatus.status,
      'the build is still in flight — simulator must remain gated behind a non-ready status',
    ).toBe('compiling')
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

  it('a CompileModeStore push with relaunch=true drives relaunch(): relaunchNonce bumps and compileConfig reflects the new selection', async () => {
    const { result } = await renderReadySession()
    const nonceBefore = readNonce(result.current)

    emitCompileModesChanged({
      revision: 99,
      state: {
        selectedId: 'm1',
        entries: [{
          id: 'm1',
          mode: { name: '购物车', pathName: 'pages/cart/cart', query: 'from=compile-mode', scene: 1001 },
        }],
      },
      relaunch: true,
    })

    await waitFor(() => {
      expect(rebuildProjectMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(
        result.current.compileConfig,
        'compileConfig must re-derive from the newly pushed selection, not the pre-push mode',
      ).toEqual({
        startPage: 'pages/cart/cart',
        scene: 1001,
        queryParams: [{ key: 'from', value: 'compile-mode' }],
      })
    })
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
