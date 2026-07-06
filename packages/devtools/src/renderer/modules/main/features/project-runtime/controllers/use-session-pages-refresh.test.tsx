/**
 * Contract: when a `project:status` payload carries a `pages` array (the
 * main-process rebuild handler now re-reads app.json and republishes it —
 * see `workspace-status-pages-refresh.test.ts`), `useSession`'s `pages`
 * state must pick it up.
 *
 * Today the `onProjectStatus` subscription in use-session.ts only does
 * `setCompileStatus(data)` — it never looks at `data.pages`, so the pages
 * array set once at the initial `getProjectPages(projectPath)` call stays
 * stale forever afterward: a page added by a hot-reloaded rebuild never
 * shows up anywhere in the renderer (e.g. the popover's 启动页面 dropdown)
 * until the whole project is re-opened.
 *
 * Pattern lifted from `use-session-hot-reload.test.tsx` (hoisted listener
 * registry mocking `@/shared/api`, `renderHook` + `waitFor` for the initial
 * ready state, then `act` + a synthetic emission).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { projectStatusListeners } = vi.hoisted(() => ({
  projectStatusListeners: [] as Array<(s: unknown) => void>,
}))

function emitProjectStatus(payload: {
  status: string
  message: string
  hotReload?: boolean
  pages?: string[]
}): void {
  for (const fn of [...projectStatusListeners]) fn(payload)
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
    onSessionRuntimeStatus: vi.fn(() => () => {}),
    onProjectStatus: vi.fn((handler: (s: unknown) => void) => {
      projectStatusListeners.push(handler)
      return () => {
        const i = projectStatusListeners.indexOf(handler)
        if (i >= 0) projectStatusListeners.splice(i, 1)
      }
    }),
    onCompileLog: vi.fn(() => () => {}),
  }
})

import { useSession } from './use-session'

beforeEach(() => {
  projectStatusListeners.length = 0
})

async function renderReadySession() {
  const rendered = renderHook(() => useSession({ projectPath: '/tmp/fake-project' }))
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

describe('useSession: a projectStatus payload carrying `pages` refreshes the pages state', () => {
  it('starts with the pages read from the initial getProjectPages call', async () => {
    const { result } = await renderReadySession()
    expect(result.current.pages).toEqual(['pages/index/index'])
  })

  it('replaces `pages` when a hotReload status payload carries a fresh pages array', async () => {
    const { result } = await renderReadySession()
    expect(result.current.pages).toEqual(['pages/index/index'])

    act(() => {
      emitProjectStatus({
        status: 'ready',
        message: '编译完成，已重启',
        hotReload: true,
        pages: ['pages/index/index', 'pages/new/new'],
      })
    })

    expect(
      result.current.pages,
      'useSession must adopt the pages array carried on a projectStatus payload',
    ).toEqual(['pages/index/index', 'pages/new/new'])
  })

  it('leaves `pages` untouched when a status payload carries no pages field (plain status chatter)', async () => {
    const { result } = await renderReadySession()

    act(() => {
      emitProjectStatus({ status: 'compiling', message: '正在编译...' })
    })

    expect(result.current.pages).toEqual(['pages/index/index'])
  })
})
