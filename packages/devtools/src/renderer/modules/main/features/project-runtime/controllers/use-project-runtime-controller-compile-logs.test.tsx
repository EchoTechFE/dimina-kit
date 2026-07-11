/**
 * Controller passthrough contract for `compileLogs` (dmcc 日志链路). Mirrors
 * the use-project-runtime-controller-compile-events suite: sub-hooks mocked at
 * their module seams, asserting ONLY the session-slice assembly.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const sessionSeam = vi.hoisted(() => {
  const compileLogs = [
    { at: 1765500000000, stream: 'stdout', text: '✔ 输出编译产物' },
    { at: 1765500000001, stream: 'stderr', text: '✖ 编译页面逻辑 [FAILED: …]' },
  ]
  return { compileLogs }
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
    compileEvents: [],
    clearCompileEvents: vi.fn(),
    compileLogs: sessionSeam.compileLogs,
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
    appData: { bridges: [], activeBridgeId: null, entries: {} },
    refreshAppData: vi.fn(),
    setActiveAppDataBridge: vi.fn(),
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

describe('useProjectRuntimeController: session slice passes compileLogs through (ROUND 2)', () => {
  it('exposes session.compileLogs from useSession', () => {
    const { result } = renderHook(() =>
      useProjectRuntimeController({ projectPath: '/tmp/fake-project' }),
    )

    const logs = (result.current.session as unknown as { compileLogs?: unknown })
      .compileLogs
    expect(
      Array.isArray(logs),
      'controller.session must pass useSession().compileLogs through — ProjectRuntime feeds BottomDebugPanel.compileLogs from this slice',
    ).toBe(true)
    expect(logs).toEqual(sessionSeam.compileLogs)
  })
})
