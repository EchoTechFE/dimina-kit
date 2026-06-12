/**
 * ROUND 2 (dmcc 日志链路) — controller passthrough contract for
 * `compileLogs` (TDD, NOT yet implemented). Mirrors the wave-1
 * use-project-runtime-controller-compile-events suite: sub-hooks mocked at
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
    wxmlTree: null,
    appData: { bridges: [], activeBridgeId: null, entries: {} },
    storageItems: [],
    refreshWxml: vi.fn(),
    refreshAppData: vi.fn(),
    setActiveAppDataBridge: vi.fn(),
    refreshStorage: vi.fn(),
    setStorageItem: vi.fn(),
    removeStorageItem: vi.fn(),
    clearStorage: vi.fn(),
    clearAllStorage: vi.fn(),
    getStoragePrefix: vi.fn(),
    inspectWxmlElement: vi.fn(),
    clearWxmlElementInspection: vi.fn(),
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
