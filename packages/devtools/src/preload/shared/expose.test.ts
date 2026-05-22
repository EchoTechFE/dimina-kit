import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exposeOnMainWorld } from './expose'

// Stub electron's contextBridge; each test drives exposeInMainWorld's
// behaviour (resolve vs throw) through mockExposeInMainWorld.
const { mockExposeInMainWorld } = vi.hoisted(() => ({ mockExposeInMainWorld: vi.fn() }))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
}))

describe('exposeOnMainWorld', () => {
  beforeEach(() => {
    mockExposeInMainWorld.mockReset()
  })

  afterEach(() => {
    // 清理 window 上可能残留的测试键
    const win = window as unknown as Record<string, unknown>
    delete win['__test_key__']
    delete win['__fallback_key__']
  })

  it('calls contextBridge.exposeInMainWorld with the given key and value', () => {
    const value = { hello: 'world' }
    exposeOnMainWorld('__test_key__', value)
    expect(mockExposeInMainWorld).toHaveBeenCalledWith('__test_key__', value)
  })

  it('does NOT assign to window[key] when contextBridge succeeds', () => {
    mockExposeInMainWorld.mockImplementation(() => undefined) // 成功
    const value = { ok: true }
    exposeOnMainWorld('__test_key__', value)
    // contextBridge 成功路径不应碰 window
    expect((window as unknown as Record<string, unknown>)['__test_key__']).toBeUndefined()
  })

  it('disposer is a no-op and does not throw when contextBridge succeeded', () => {
    mockExposeInMainWorld.mockImplementation(() => undefined)
    const value = { ok: true }
    const dispose = exposeOnMainWorld('__test_key__', value)
    expect(() => dispose()).not.toThrow()
  })

  it('falls back to window[key] = value when contextBridge throws', () => {
    mockExposeInMainWorld.mockImplementation(() => {
      throw new Error('contextIsolation disabled')
    })
    const value = { fallback: true }
    exposeOnMainWorld('__fallback_key__', value)
    // 应走 fallback，window[key] 严格等于 value 同一引用
    expect((window as unknown as Record<string, unknown>)['__fallback_key__']).toBe(value)
  })

  it('disposer deletes window[key] after fallback when value is unchanged', () => {
    mockExposeInMainWorld.mockImplementation(() => {
      throw new Error('contextIsolation disabled')
    })
    const value = { toDelete: true }
    const dispose = exposeOnMainWorld('__fallback_key__', value)
    // 先确认已赋值
    expect((window as unknown as Record<string, unknown>)['__fallback_key__']).toBe(value)
    dispose()
    // disposer 应删除 window[key]
    expect('__fallback_key__' in (window as unknown as Record<string, unknown>)).toBe(false)
  })

  it('disposer does NOT delete window[key] when it has been replaced after fallback', () => {
    mockExposeInMainWorld.mockImplementation(() => {
      throw new Error('contextIsolation disabled')
    })
    const originalValue = { original: true }
    const newValue = { replaced: true }
    const dispose = exposeOnMainWorld('__fallback_key__', originalValue)
    // 模拟别人覆盖了 window[key]
    ;(window as unknown as Record<string, unknown>)['__fallback_key__'] = newValue
    dispose()
    // disposer 不应删除新值
    expect((window as unknown as Record<string, unknown>)['__fallback_key__']).toBe(newValue)
  })
})
