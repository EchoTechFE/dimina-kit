import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: {
    sendToHost: vi.fn(),
    on: vi.fn(),
  },
}))

import { ipcRenderer } from 'electron'
import { sendToHost, safeSerialize } from './host'

describe('sendToHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to ipcRenderer.sendToHost', () => {
    sendToHost('my-channel', { foo: 1 })
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('my-channel', { foo: 1 })
  })

  it('passes primitive data through', () => {
    sendToHost('ch', 'hello')
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('ch', 'hello')
  })
})

describe('safeSerialize', () => {
  it('returns null as-is', () => {
    expect(safeSerialize(null)).toBeNull()
  })

  it('returns undefined as-is', () => {
    expect(safeSerialize(undefined)).toBeUndefined()
  })

  it('returns a named function as [Function: name]', () => {
    function myFunc() {}
    expect(safeSerialize(myFunc)).toBe('[Function: myFunc]')
  })

  it('returns an anonymous function as [Function: anonymous]', () => {
     
    expect(safeSerialize(Function())).toBe('[Function: anonymous]')
  })

  it('returns a number as-is', () => {
    expect(safeSerialize(42)).toBe(42)
  })

  it('returns a string as-is', () => {
    expect(safeSerialize('hello')).toBe('hello')
  })

  it('returns a boolean as-is', () => {
    expect(safeSerialize(true)).toBe(true)
    expect(safeSerialize(false)).toBe(false)
  })

  it('serializes an Error to { __isError, message, stack }', () => {
    const err = new Error('boom')
    const result = safeSerialize(err) as Record<string, unknown>
    expect(result).toEqual({
      __isError: true,
      message: 'boom',
      stack: err.stack,
    })
  })

  it('clones a plain object via structuredClone', () => {
    const obj = { a: 1, b: [2, 3] }
    const result = safeSerialize(obj)
    expect(result).toEqual(obj)
    expect(result).not.toBe(obj) // should be a clone
  })

  it('falls back to JSON round-trip when structuredClone fails', () => {
    const original = structuredClone
    globalThis.structuredClone = () => { throw new Error('not supported') }
    try {
      const obj = { x: 'test' }
      const result = safeSerialize(obj)
      expect(result).toEqual({ x: 'test' })
    } finally {
      globalThis.structuredClone = original
    }
  })

  it('falls back to String() when both structuredClone and JSON fail', () => {
    const original = structuredClone
    globalThis.structuredClone = () => { throw new Error('nope') }
    try {
      // Create a circular reference that JSON.stringify cannot handle
      const obj: Record<string, unknown> = {}
      obj.self = obj
      const result = safeSerialize(obj)
      expect(typeof result).toBe('string')
    } finally {
      globalThis.structuredClone = original
    }
  })
})
