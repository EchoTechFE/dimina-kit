/**
 * `applyCompileModes` persists an edited compile-mode list to disk via
 * `saveCompileModes`, then (optionally) relaunches with it. The write can
 * fail — a read-only project dir, a JSON parse error in the target config
 * file — and a failed write must not leave the renderer believing the edit
 * took effect: the in-memory `compileModes`/`compileConfig` must stay on the
 * last value that is actually ON DISK, and nothing should relaunch the
 * simulator into a configuration that doesn't exist there.
 *
 * Pattern lifted from use-session-relaunch-rebuild.test.tsx (hoisted
 * `@/shared/api` mock, renderHook + waitFor for the initial ready state).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { CompileModes } from '@/shared/types'

const { rebuildProjectMock, saveCompileModesMock } = vi.hoisted(() => ({
  rebuildProjectMock: vi.fn(async (): Promise<unknown> => undefined),
  saveCompileModesMock: vi.fn(async (): Promise<void> => {}),
}))

vi.mock('@/shared/api', () => {
  return {
    openProject: vi.fn(async () => ({
      success: true,
      appInfo: { appId: 'apply-compile-modes-app' },
      port: 12345,
    })),
    getProjectPages: vi.fn(async () => ({
      pages: ['pages/index/index'],
      entryPagePath: 'pages/index/index',
    })),
    getCompileModes: vi.fn(async () => ({ current: -1, list: [] })),
    saveCompileModes: saveCompileModesMock,
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
  saveCompileModesMock.mockClear()
  saveCompileModesMock.mockImplementation(async () => {})
})

async function renderReadySession() {
  const rendered = renderHook(() => useSession({ projectPath: '/tmp/apply-compile-modes-project' }))
  await waitFor(() => {
    expect(rendered.result.current.compileStatus.status).toBe('ready')
  })
  return rendered
}

const nextModes: CompileModes = {
  current: 0,
  list: [{ name: '购物车', pathName: 'pages/cart/cart', query: 'from=compile-mode', scene: 1001 }],
}

describe('useSession.applyCompileModes(): 落盘失败不得让内存状态领先于磁盘', () => {
  it('saveCompileModes 失败时，compileModes/compileConfig 保持旧值，且不触发 rebuildProject', async () => {
    saveCompileModesMock.mockRejectedValueOnce(new Error('磁盘写入失败'))
    const { result } = await renderReadySession()
    const modesBefore = result.current.compileModes
    const configBefore = result.current.compileConfig

    await act(async () => {
      await result.current.applyCompileModes(nextModes, true)
    })

    expect(
      result.current.compileModes,
      '保存失败，用户的编辑还没有落到磁盘上，不能被当作已采纳',
    ).toEqual(modesBefore)
    expect(
      result.current.compileConfig,
      '派生的启动参数同样不能领先于磁盘上的旧配置',
    ).toEqual(configBefore)
    expect(result.current.compileConfig.startPage).not.toBe('pages/cart/cart')
    expect(
      rebuildProjectMock,
      '磁盘上根本不存在这份新配置，不能拿它去重建/重启模拟器',
    ).not.toHaveBeenCalled()
    expect(result.current.compileStatus.status).toBe('error')
  })

  it('saveCompileModes 成功且 shouldRelaunch=true 时，采纳新模式并触发 rebuildProject', async () => {
    const { result } = await renderReadySession()

    await act(async () => {
      await result.current.applyCompileModes(nextModes, true)
    })

    expect(result.current.compileModes).toEqual(nextModes)
    expect(result.current.compileConfig).toEqual({
      startPage: 'pages/cart/cart',
      scene: 1001,
      queryParams: [{ key: 'from', value: 'compile-mode' }],
    })
    expect(rebuildProjectMock).toHaveBeenCalledTimes(1)
  })

  it('saveCompileModes 成功但 shouldRelaunch=false 时，采纳新模式但不触发 rebuildProject', async () => {
    const { result } = await renderReadySession()

    await act(async () => {
      await result.current.applyCompileModes(nextModes, false)
    })

    expect(
      result.current.compileModes,
      '编辑非当前运行的模式也要被采纳/持久化，只是不重启',
    ).toEqual(nextModes)
    expect(rebuildProjectMock).not.toHaveBeenCalled()
  })
})
