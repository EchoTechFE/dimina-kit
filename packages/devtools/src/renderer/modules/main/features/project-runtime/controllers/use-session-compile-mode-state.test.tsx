/**
 * `useSession` no longer owns compile modes — it mirrors whatever the main
 * process's `CompileModeStore` says. Two invariants this exercises:
 *  - subscribe-before-fetch: `onCompileModesChanged` is subscribed before
 *    `getCompileModeState` is even called, so a push that lands while the
 *    initial fetch is still in flight cannot be missed.
 *  - revision-gated adoption: whichever of the fetch/pushes carries the
 *    HIGHEST revision wins, regardless of which one settles last — a slow
 *    fetch resolving after a fresher push must not roll the state backward.
 *
 * Pattern lifted from the deleted use-session-apply-compile-modes.test.tsx
 * (hoisted `@/shared/api` mock, `renderReadySession()` helper) and from
 * popover-invalid-startpage.test.tsx's listener-array capture for a
 * subscribe-style mock (`onPopoverInit` there, `onCompileModesChanged` /
 * `onCompileModesApplyFailed` here).
 *
 * Design: /Volumes/jdisk/code/dimina-kit-docs/compile-mode-store-design.md §2.6
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

interface FakeCompileModeState {
  selectedId: string | null
  entries: Array<{ id: string; mode: { name: string; pathName: string; query: string; scene: number | null } }>
}
interface FakeChange {
  revision: number
  state: FakeCompileModeState
  relaunch: boolean
}

const {
  rebuildProjectMock,
  getCompileModeStateMock,
  openProjectMock,
  changeListeners,
  applyFailedListeners,
} = vi.hoisted(() => ({
  rebuildProjectMock: vi.fn(async (): Promise<unknown> => undefined),
  getCompileModeStateMock: vi.fn(async (): Promise<FakeChange> => ({
    revision: 1,
    state: { selectedId: null, entries: [] },
    relaunch: false,
  })),
  openProjectMock: vi.fn(async () => ({
    success: true,
    appInfo: { appId: 'compile-mode-state-app' },
    port: 12345,
  })),
  changeListeners: [] as Array<(change: FakeChange) => void>,
  applyFailedListeners: [] as Array<(payload: { message: string }) => void>,
}))

function emitCompileModesChanged(change: FakeChange): void {
  for (const fn of [...changeListeners]) fn(change)
}

function emitCompileModesApplyFailed(payload: { message: string }): void {
  for (const fn of [...applyFailedListeners]) fn(payload)
}

vi.mock('@/shared/api', () => ({
  openProject: openProjectMock,
  getProjectPages: vi.fn(async () => ({
    pages: ['pages/index/index'],
    entryPagePath: 'pages/index/index',
  })),
  getCompileModeState: getCompileModeStateMock,
  onCompileModesChanged: vi.fn((handler: (change: FakeChange) => void) => {
    changeListeners.push(handler)
    return () => {
      const idx = changeListeners.indexOf(handler)
      if (idx >= 0) changeListeners.splice(idx, 1)
    }
  }),
  onCompileModesApplyFailed: vi.fn((handler: (payload: { message: string }) => void) => {
    applyFailedListeners.push(handler)
    return () => {
      const idx = applyFailedListeners.indexOf(handler)
      if (idx >= 0) applyFailedListeners.splice(idx, 1)
    }
  }),
  onSessionRuntimeStatus: vi.fn(() => () => {}),
  onProjectStatus: vi.fn(() => () => {}),
  onCompileLog: vi.fn(() => () => {}),
  rebuildProject: rebuildProjectMock,
}))

import { useSession } from './use-session'

beforeEach(() => {
  changeListeners.length = 0
  applyFailedListeners.length = 0
  rebuildProjectMock.mockClear()
  rebuildProjectMock.mockImplementation(async () => undefined)
  getCompileModeStateMock.mockClear()
  getCompileModeStateMock.mockImplementation(async () => ({
    revision: 1,
    state: { selectedId: null, entries: [] },
    relaunch: false,
  }))
  openProjectMock.mockClear()
  openProjectMock.mockImplementation(async () => ({
    success: true,
    appInfo: { appId: 'compile-mode-state-app' },
    port: 12345,
  }))
})

async function renderReadySession() {
  const rendered = renderHook(() => useSession({ projectPath: '/tmp/compile-mode-state-project' }))
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

const modeA = { name: '购物车', pathName: 'pages/cart/cart', query: 'from=compile-mode', scene: 1001 }

describe('useSession: adopts the initial state fetched via getCompileModeState', () => {
  it('compileModes equals whatever getCompileModeState resolved with', async () => {
    getCompileModeStateMock.mockResolvedValue({
      revision: 5,
      state: { selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] },
      relaunch: false,
    })
    const { result } = await renderReadySession()

    expect(result.current.compileModes).toEqual({ selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] })
  })
})

describe('useSession: adopts pushed changes and relaunches according to their flag', () => {
  it('a pushed change with relaunch=true is adopted and triggers rebuildProject once', async () => {
    const { result } = await renderReadySession()
    rebuildProjectMock.mockClear()

    emitCompileModesChanged({
      revision: 99,
      state: { selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] },
      relaunch: true,
    })

    await waitFor(() => {
      expect(result.current.compileModes).toEqual({ selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] })
    })
    await waitFor(() => {
      expect(rebuildProjectMock).toHaveBeenCalledTimes(1)
    })
  })

  it('a pushed change with relaunch=false is adopted but does not trigger rebuildProject', async () => {
    const { result } = await renderReadySession()
    rebuildProjectMock.mockClear()

    emitCompileModesChanged({
      revision: 99,
      state: { selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] },
      relaunch: false,
    })

    await waitFor(() => {
      expect(result.current.compileModes).toEqual({ selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] })
    })
    expect(rebuildProjectMock).not.toHaveBeenCalled()
  })
})

describe('useSession: revision-gated adoption — the highest revision wins regardless of arrival order', () => {
  it('a lower-revision fetch resolving AFTER a higher-revision push must not roll the state back', async () => {
    let resolveFetch!: (change: FakeChange) => void
    getCompileModeStateMock.mockImplementation(
      () => new Promise<FakeChange>((resolve) => { resolveFetch = resolve }),
    )

    const rendered = renderHook(() => useSession({ projectPath: '/tmp/compile-mode-state-project' }))

    // The fetch is still in flight. A push with a HIGHER revision lands first.
    await waitFor(() => expect(changeListeners.length).toBeGreaterThan(0))
    emitCompileModesChanged({
      revision: 7,
      state: { selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] },
      relaunch: false,
    })

    // The slow fetch now resolves with a STALE (lower) revision.
    resolveFetch({ revision: 2, state: { selectedId: null, entries: [] }, relaunch: false })

    await waitFor(() => {
      expect(rendered.result.current.compileStatus.status).toBe('ready')
    })
    expect(
      rendered.result.current.compileModes,
      'revision 7 (the push) must win over revision 2 (the stale fetch), even though the fetch settled later',
    ).toEqual({ selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] })
  })

  it('subscribes to onCompileModesChanged before calling getCompileModeState', async () => {
    const callOrder: string[] = []
    getCompileModeStateMock.mockImplementation(async () => {
      callOrder.push('fetch-called')
      return { revision: 1, state: { selectedId: null, entries: [] }, relaunch: false }
    })
    const originalPush = changeListeners.push.bind(changeListeners)
    changeListeners.push = ((...args: Array<(change: FakeChange) => void>) => {
      callOrder.push('subscribed')
      return originalPush(...args)
    }) as typeof changeListeners.push

    await renderReadySession()

    expect(callOrder.indexOf('subscribed')).toBeLessThan(callOrder.indexOf('fetch-called'))
    changeListeners.push = originalPush
  })
})

describe('useSession: apply-failed pushes surface as a compileStatus error without touching state', () => {
  it('sets compileStatus to error with the pushed message and leaves compileModes untouched', async () => {
    getCompileModeStateMock.mockResolvedValue({
      revision: 1,
      state: { selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] },
      relaunch: false,
    })
    const { result } = await renderReadySession()
    const modesBefore = result.current.compileModes

    emitCompileModesApplyFailed({ message: '磁盘写入失败' })

    await waitFor(() => {
      expect(result.current.compileStatus).toEqual({ status: 'error', message: '磁盘写入失败' })
    })
    expect(result.current.compileModes).toEqual(modesBefore)
  })
})

describe('useSession: compileConfig is derived from the selected entry', () => {
  it('普通编译 (selectedId: null) resolves startPage to the entry page', async () => {
    getCompileModeStateMock.mockResolvedValue({
      revision: 1,
      state: { selectedId: null, entries: [] },
      relaunch: false,
    })
    const { result } = await renderReadySession()

    expect(result.current.compileConfig.startPage).toBe('pages/index/index')
  })

  it('a selected entry resolves startPage/scene/queryParams from its own mode', async () => {
    getCompileModeStateMock.mockResolvedValue({
      revision: 1,
      state: { selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] },
      relaunch: false,
    })
    const { result } = await renderReadySession()

    expect(result.current.compileConfig).toEqual({
      startPage: 'pages/cart/cart',
      scene: 1001,
      queryParams: [{ key: 'from', value: 'compile-mode' }],
    })
  })
})

describe('useSession: compileModesReady tracks whether a store snapshot has been adopted yet', () => {
  it('stays false while openProject has not resolved yet', async () => {
    let resolveOpen!: (value: { success: true; appInfo: { appId: string }; port: number }) => void
    openProjectMock.mockImplementation(
      () => new Promise((resolve) => { resolveOpen = resolve }),
    )

    const { result } = renderHook(() => useSession({ projectPath: '/tmp/compile-mode-state-project' }))

    expect(result.current.compileModesReady).toBe(false)

    // Settle the held-open promise so it doesn't leak into a later test.
    resolveOpen({ success: true, appInfo: { appId: 'compile-mode-state-app' }, port: 12345 })
    await waitFor(() => expect(result.current.compileStatus.status).toBe('ready'))
  })

  it('becomes true once the initial getCompileModeState snapshot is adopted', async () => {
    const { result } = await renderReadySession()

    expect(result.current.compileModesReady).toBe(true)
  })

  it('becomes true from an onCompileModesChanged push alone, even before the fetch resolves', async () => {
    let resolveFetch!: (change: FakeChange) => void
    getCompileModeStateMock.mockImplementation(
      () => new Promise<FakeChange>((resolve) => { resolveFetch = resolve }),
    )

    const rendered = renderHook(() => useSession({ projectPath: '/tmp/compile-mode-state-project' }))
    await waitFor(() => expect(changeListeners.length).toBeGreaterThan(0))
    expect(rendered.result.current.compileModesReady).toBe(false)

    emitCompileModesChanged({
      revision: 3,
      state: { selectedId: 'm1', entries: [{ id: 'm1', mode: modeA }] },
      relaunch: false,
    })

    await waitFor(() => expect(rendered.result.current.compileModesReady).toBe(true))

    // The fetch is still pending — settle it so it doesn't leak into a later test.
    resolveFetch({ revision: 1, state: { selectedId: null, entries: [] }, relaunch: false })
  })

  it('resets to false when projectPath changes', async () => {
    const rendered = renderHook(
      ({ projectPath }: { projectPath: string }) => useSession({ projectPath }),
      { initialProps: { projectPath: '/tmp/compile-mode-state-project' } },
    )
    await waitFor(() => expect(rendered.result.current.compileModesReady).toBe(true))

    rendered.rerender({ projectPath: '/tmp/compile-mode-state-project-2' })

    expect(rendered.result.current.compileModesReady).toBe(false)
  })
})
