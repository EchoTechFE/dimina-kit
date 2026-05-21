import { describe, it, expect, vi, beforeEach } from 'vitest'

// bridge.ts 有模块级状态（exposedApi、state 等），需要 vi.resetModules() 隔离。
// electron 必须在 resetModules 之前 mock 好（vi.mock 会被 hoist）。

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    on: vi.fn(),
    sendToHost: vi.fn(),
  },
}))

describe('installSimulatorBridge — fallback path (contextBridge unavailable)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('exposes the full snapshot API on window.__simulatorData when contextBridge throws', async () => {
    // contextBridge.exposeInMainWorld 抛异常 = contextIsolation 未开启。
    // fallback 路径必须暴露与成功路径行为一致的对象（同一个 buildApi() 结果），
    // 而不是一个缺方法的子集 —— 这是 P4 收敛两条路径要守住的契约。
    const { contextBridge } = await import('electron')
    vi.mocked(contextBridge.exposeInMainWorld).mockImplementation(() => {
      throw new Error('contextIsolation is not enabled')
    })

    const { installSimulatorBridge } = await import('./bridge.js')
    installSimulatorBridge()

    const api = (window as unknown as Record<string, unknown>).__simulatorData as Record<string, unknown>
    for (const key of ['getAppdata', 'getAppdataSnapshot', 'getStorageSnapshot', 'getWxml', 'getWxmlSnapshot'] as const) {
      expect(typeof api[key], `${key} should be a function in the fallback path`).toBe('function')
    }
  })
})
