/**
 * 编译信息 tab — controller passthrough contract.
 *
 * `useProjectRuntimeController` assembles the session slice consumed by
 * `project-runtime.tsx`. The compile log lives in `useSession`; the
 * controller must pass `compileEvents` + `clearCompileEvents` through on
 * `controller.session` so ProjectRuntime can hand them to BottomDebugPanel.
 *
 * All sub-hooks are mocked at their module seams — this suite asserts ONLY
 * the slice assembly (a passthrough the controller currently drops on the
 * floor, which is exactly the red).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const sessionSeam = vi.hoisted(() => {
  const compileEvents = [
    { at: 1718160000000, status: 'ready', message: '编译完成', hotReload: true },
  ]
  return {
    compileEvents,
    clearCompileEvents: vi.fn(),
  }
})

vi.mock('./use-session', () => ({
  useSession: vi.fn(() => ({
    compileStatus: { status: 'ready', message: '编译完成' },
    appInfo: { appId: 'fake-app' },
    port: 12345,
    pages: ['pages/index/index'],
    compileConfig: { startPage: 'pages/index/index', scene: 1011, queryParams: [] },
    hotReloadToken: 0,
    relaunch: vi.fn(),
    compileEvents: sessionSeam.compileEvents,
    clearCompileEvents: sessionSeam.clearCompileEvents,
  })),
}))

vi.mock('./use-device', () => ({
  useDevice: vi.fn(() => ({
    device: { name: 'fake-device', width: 375, height: 812 },
    zoom: 100,
    simPanelWidth: 400,
    simPanelWidthRef: { current: 400 },
    deviceRef: { current: { name: 'fake-device', width: 375, height: 812 } },
    setSimPanelWidth: vi.fn(),
    handleDeviceChange: vi.fn(),
    handleZoomChange: vi.fn(),
    handleSplitterDrag: vi.fn(),
    sendDeviceInfo: vi.fn(),
  })),
}))

vi.mock('./use-simulator', () => ({
  useSimulator: vi.fn(() => ({
    simulatorUrl: '',
    currentPage: '',
  })),
}))

vi.mock('./use-panel-data', () => ({
  usePanelData: vi.fn(() => ({
    wxmlSource: {
      getSnapshot: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      setActive: vi.fn(),
      inspect: vi.fn(async () => null),
      clearInspection: vi.fn(),
    },
    wxmlEnabled: true,
    storageSource: {
      getSnapshot: vi.fn(async () => []),
      subscribe: vi.fn(() => () => {}),
      setActive: vi.fn(),
      setItem: vi.fn(async () => ({ ok: true })),
      removeItem: vi.fn(async () => ({ ok: true })),
      clear: vi.fn(async () => ({ ok: true })),
      getPrefix: vi.fn(async () => ''),
    },
    storageEnabled: true,
    appDataSource: {
      getSnapshot: vi.fn(async () => ({ bridges: [], entries: {} })),
      subscribe: vi.fn(() => () => {}),
      setActive: vi.fn(),
    },
    appDataEnabled: true,
  })),
}))

vi.mock('./use-right-pane', () => ({
  useRightPane: vi.fn(() => ({
    rightPane: { selected: 'simulator', simulatorVisible: true },
    selectRightPane: vi.fn(),
    toggleRightPaneVisible: vi.fn(),
  })),
}))

vi.mock('./use-popover', () => ({
  usePopover: vi.fn(() => ({
    showCompilePanel: false,
    toggleCompilePanel: vi.fn(),
  })),
}))

import { useProjectRuntimeController } from './use-project-runtime-controller'

describe('useProjectRuntimeController: session slice passes the compile log through', () => {
  it('exposes session.compileEvents from useSession', () => {
    const { result } = renderHook(() =>
      useProjectRuntimeController({ projectPath: '/tmp/fake-project' }),
    )

    const events = (result.current.session as unknown as { compileEvents?: unknown })
      .compileEvents
    expect(
      Array.isArray(events),
      'controller.session must pass useSession().compileEvents through — ProjectRuntime feeds BottomDebugPanel from this slice',
    ).toBe(true)
    expect(events).toEqual(sessionSeam.compileEvents)
  })

  it('exposes session.clearCompileEvents wired to useSession’s clear', () => {
    const { result } = renderHook(() =>
      useProjectRuntimeController({ projectPath: '/tmp/fake-project' }),
    )

    const clear = (result.current.session as unknown as { clearCompileEvents?: unknown })
      .clearCompileEvents
    expect(
      typeof clear,
      'controller.session must pass useSession().clearCompileEvents through',
    ).toBe('function')
    ;(clear as () => void)()
    expect(sessionSeam.clearCompileEvents).toHaveBeenCalledTimes(1)
  })
})
