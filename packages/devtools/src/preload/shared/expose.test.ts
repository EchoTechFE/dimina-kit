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

// `process.contextIsolated` is the renderer-frame discriminator the helper
// reads. Tests set it per-case; restore after each.
function setContextIsolated(value: boolean | undefined): void {
  Object.defineProperty(process, 'contextIsolated', {
    value,
    configurable: true,
    writable: true,
  })
}

describe('exposeOnMainWorld', () => {
  const originalContextIsolated = (process as unknown as { contextIsolated?: boolean }).contextIsolated

  beforeEach(() => {
    mockExposeInMainWorld.mockReset()
  })

  afterEach(() => {
    setContextIsolated(originalContextIsolated)
    // 清理 window 上可能残留的测试键
    const win = window as unknown as Record<string, unknown>
    delete win['__test_key__']
    delete win['__fallback_key__']
  })

  describe('contextIsolation ON (process.contextIsolated === true)', () => {
    beforeEach(() => setContextIsolated(true))

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
        throw new Error('unexpected contextBridge failure')
      })
      const value = { fallback: true }
      exposeOnMainWorld('__fallback_key__', value)
      // 应走 fallback，window[key] 严格等于 value 同一引用
      expect((window as unknown as Record<string, unknown>)['__fallback_key__']).toBe(value)
    })

    it('disposer deletes window[key] after fallback when value is unchanged', () => {
      mockExposeInMainWorld.mockImplementation(() => {
        throw new Error('unexpected contextBridge failure')
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
        throw new Error('unexpected contextBridge failure')
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

  describe('contextIsolation OFF (process.contextIsolated === false)', () => {
    beforeEach(() => setContextIsolated(false))

    it('assigns window[key] = value directly without calling contextBridge', () => {
      const value = { direct: true }
      exposeOnMainWorld('__fallback_key__', value)
      // 不应调用 contextBridge（不再有"必然失败的尝试"）
      expect(mockExposeInMainWorld).not.toHaveBeenCalled()
      // 直接赋到 window 上，同一引用
      expect((window as unknown as Record<string, unknown>)['__fallback_key__']).toBe(value)
    })

    it('does NOT warn when contextIsolation is off', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        exposeOnMainWorld('__fallback_key__', { quiet: true })
        expect(warn).not.toHaveBeenCalled()
      }
      finally {
        warn.mockRestore()
      }
    })

    it('disposer deletes window[key] when value is unchanged', () => {
      const value = { toDelete: true }
      const dispose = exposeOnMainWorld('__fallback_key__', value)
      expect((window as unknown as Record<string, unknown>)['__fallback_key__']).toBe(value)
      dispose()
      expect('__fallback_key__' in (window as unknown as Record<string, unknown>)).toBe(false)
    })
  })
})
