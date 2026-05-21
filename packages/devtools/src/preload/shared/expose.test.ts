import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 模拟 electron 的 contextBridge
const mockExposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
}))

// expose.ts 尚不存在；用动态 import + 字符串拼接绕过 tsc 静态检查，
// 让 vitest 在运行时抛出 MODULE_NOT_FOUND（red 阶段预期失败）。
describe('exposeOnMainWorld', () => {
  let exposeOnMainWorld: (key: string, value: unknown) => () => void

  beforeEach(async () => {
    vi.resetModules()
    mockExposeInMainWorld.mockReset()
    // 拼接路径使 tsc 无法静态解析；vitest 运行时会找不到模块而报错
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(/* @vite-ignore */ './expose' + '') as any
    exposeOnMainWorld = mod.exposeOnMainWorld
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
