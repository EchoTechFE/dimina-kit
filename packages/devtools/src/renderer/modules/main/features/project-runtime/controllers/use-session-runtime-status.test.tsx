/**
 * Contract: `useSession` subscribes to the new `onSessionRuntimeStatus`
 * channel (main pushes it from bridge-router — see
 * bridge-router-runtime-status-launch.test.ts / …-failures.test.ts) and
 * exposes it as `runtimeStatus: SessionRuntimeStatusPayload | null`.
 *
 * Today `useSession` never imports/calls `onSessionRuntimeStatus` at all —
 * spawn failures, launch timeouts, and service-host crashes are invisible to
 * every renderer consumer no matter what main pushes.
 *
 * A hot-reload rebuild (`projectStatus` payload with `hotReload: true`) must
 * reset `runtimeStatus` back to `null`: a fresh respawn is about to happen,
 * and a stale terminal phase (`launch-failed`/`crashed`) from the PREVIOUS
 * launch must not linger and paint a phantom error over the new one. A plain
 * status payload (no hotReload) must leave an existing runtimeStatus alone —
 * only a real respawn justifies clearing it.
 *
 * Pattern lifted from use-session-pages-refresh.test.tsx (hoisted listener
 * registries mocking `@/shared/api`, renderHook + waitFor for the initial
 * ready state, then act + a synthetic emission).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

interface SessionRuntimeStatusPayload {
  appId: string
  phase: 'launching' | 'running' | 'launch-failed' | 'crashed'
  code?: string
  reason?: string
  pageFallback?: { requested: string; resolved: string }
}

const { projectStatusListeners, runtimeStatusListeners } = vi.hoisted(() => ({
  projectStatusListeners: [] as Array<(s: unknown) => void>,
  runtimeStatusListeners: [] as Array<(s: SessionRuntimeStatusPayload) => void>,
}))

function emitProjectStatus(payload: {
  status: string
  message: string
  hotReload?: boolean
  pages?: string[]
}): void {
  for (const fn of [...projectStatusListeners]) fn(payload)
}

function emitSessionRuntimeStatus(payload: SessionRuntimeStatusPayload): void {
  for (const fn of [...runtimeStatusListeners]) fn(payload)
}

vi.mock('@/shared/api', () => {
  return {
    openProject: vi.fn(async () => ({
      success: true,
      appInfo: { appId: 'fake-app' },
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
    getLaunchConfigs: vi.fn(async () => []),
    getActiveLaunchConfigId: vi.fn(async () => null),
    saveCompileConfig: vi.fn(async () => {}),
    onProjectStatus: vi.fn((handler: (s: unknown) => void) => {
      projectStatusListeners.push(handler)
      return () => {
        const i = projectStatusListeners.indexOf(handler)
        if (i >= 0) projectStatusListeners.splice(i, 1)
      }
    }),
    onCompileLog: vi.fn(() => () => {}),
    onSessionRuntimeStatus: vi.fn((handler: (s: SessionRuntimeStatusPayload) => void) => {
      runtimeStatusListeners.push(handler)
      return () => {
        const i = runtimeStatusListeners.indexOf(handler)
        if (i >= 0) runtimeStatusListeners.splice(i, 1)
      }
    }),
  }
})

import { useSession } from './use-session'
import * as sharedApi from '@/shared/api'

beforeEach(() => {
  projectStatusListeners.length = 0
  runtimeStatusListeners.length = 0
})

async function renderReadySession() {
  const rendered = renderHook(() => useSession({ projectPath: '/tmp/fake-project' }))
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

describe('useSession: subscribes to onSessionRuntimeStatus and exposes runtimeStatus', () => {
  it('starts with runtimeStatus: null', async () => {
    const { result } = await renderReadySession()
    expect(result.current.runtimeStatus).toBeNull()
  })

  it('subscribes to the onSessionRuntimeStatus channel on mount', async () => {
    await renderReadySession()
    expect(
      sharedApi.onSessionRuntimeStatus,
      'useSession must call onSessionRuntimeStatus so a spawn/launch/crash failure is observable in the renderer',
    ).toHaveBeenCalled()
  })

  it('updates runtimeStatus to the pushed payload', async () => {
    const { result } = await renderReadySession()

    const payload: SessionRuntimeStatusPayload = { appId: 'fake-app', phase: 'launch-failed', code: 'timeout', reason: 'boom' }
    act(() => {
      emitSessionRuntimeStatus(payload)
    })

    expect(result.current.runtimeStatus).toEqual(payload)
  })

  it('ignores a broadcast for a DIFFERENT app (stale event from a previous project must not paint this panel)', async () => {
    // The runtime-status channel is a global broadcast: a dying previous
    // session's crash can land mid-project-switch. Only payloads for the app
    // currently shown may update the panel state.
    const { result } = await renderReadySession()

    act(() => {
      emitSessionRuntimeStatus({ appId: 'some-other-app', phase: 'crashed', code: 'service-host-crashed' })
    })

    expect(
      result.current.runtimeStatus,
      'a crashed broadcast for another appId must not become this project\'s runtimeStatus',
    ).toBeNull()
  })

  it('resets runtimeStatus to null when a hotReload projectStatus payload arrives (fresh respawn clears the stale terminal phase)', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitSessionRuntimeStatus({ appId: 'fake-app', phase: 'crashed', code: 'service-host-crashed' })
    })
    expect(result.current.runtimeStatus?.phase).toBe('crashed')

    act(() => {
      emitProjectStatus({ status: 'ready', message: '编译完成，已重启', hotReload: true })
    })

    expect(
      result.current.runtimeStatus,
      'a hot-reload rebuild is about to respawn — the previous launch\'s terminal runtimeStatus must not linger',
    ).toBeNull()
  })

  it('does NOT reset runtimeStatus on a plain (non-hotReload) projectStatus payload', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitSessionRuntimeStatus({ appId: 'fake-app', phase: 'running' })
    })
    expect(result.current.runtimeStatus?.phase).toBe('running')

    act(() => {
      emitProjectStatus({ status: 'compiling', message: '正在编译...' })
    })

    expect(
      result.current.runtimeStatus?.phase,
      'plain status chatter (no hotReload) must not clear an existing runtimeStatus',
    ).toBe('running')
  })
})
