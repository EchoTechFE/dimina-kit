import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpRuntimeStatus } from './status.js'

// status.ts 有模块级状态，每个测试前用 vi.resetModules() + 动态 import 隔离，
// 保证每个 test 都从全空状态开始。

type StatusModule = {
  getMcpStatus: () => McpRuntimeStatus
  recordMcpStarted: (port: number) => void
  recordMcpFailed: (error: string) => void
  recordMcpStopped: () => void
}

async function loadStatus(): Promise<StatusModule> {
  return import('./status.js')
}

describe('McpRuntimeStatus module', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('初始状态: getMcpStatus() 返回 { running: false, port: null, error: null }', async () => {
    const { getMcpStatus } = await loadStatus()
    expect(getMcpStatus()).toEqual({ running: false, port: null, error: null })
  })

  it('recordMcpStarted(port) 后: running=true, port 正确, error=null', async () => {
    const { getMcpStatus, recordMcpStarted } = await loadStatus()
    recordMcpStarted(7789)
    expect(getMcpStatus()).toEqual({ running: true, port: 7789, error: null })
  })

  it('recordMcpFailed(reason) 后: running=false, port=null, error 为传入 reason', async () => {
    const { getMcpStatus, recordMcpFailed } = await loadStatus()
    recordMcpFailed('port-in-use')
    expect(getMcpStatus()).toEqual({ running: false, port: null, error: 'port-in-use' })
  })

  it('recordMcpStopped() 后: 回到全空 { running: false, port: null, error: null }', async () => {
    const { getMcpStatus, recordMcpStarted, recordMcpStopped } = await loadStatus()
    recordMcpStarted(3000)
    recordMcpStopped()
    expect(getMcpStatus()).toEqual({ running: false, port: null, error: null })
  })

  it('最后一次胜出: started → failed 后是 failed 态', async () => {
    const { getMcpStatus, recordMcpStarted, recordMcpFailed } = await loadStatus()
    recordMcpStarted(8080)
    recordMcpFailed('address-already-in-use')
    expect(getMcpStatus()).toEqual({ running: false, port: null, error: 'address-already-in-use' })
  })

  it('最后一次胜出: failed → started 后是 started 态', async () => {
    const { getMcpStatus, recordMcpStarted, recordMcpFailed } = await loadStatus()
    recordMcpFailed('eacces')
    recordMcpStarted(9000)
    expect(getMcpStatus()).toEqual({ running: true, port: 9000, error: null })
  })

  it('getMcpStatus() 返回副本: 修改返回对象不影响下一次调用结果', async () => {
    const { getMcpStatus, recordMcpStarted } = await loadStatus()
    recordMcpStarted(7789)

    const snapshot = getMcpStatus()
    // 篡改副本的每个字段
    snapshot.running = false
    snapshot.port = 9999
    snapshot.error = 'injected'

    // 下一次读取应不受影响
    expect(getMcpStatus()).toEqual({ running: true, port: 7789, error: null })
  })
})
