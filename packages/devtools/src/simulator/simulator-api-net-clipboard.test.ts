import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import {
  getClipboardData,
  getNetworkType,
  resolveNetworkType,
  setClipboardData,
} from './simulator-api-device'

function makeCtx(): MiniAppContext {
  return {
    appId: 'test-app',
    createCallbackFunction: (fn: unknown) => fn,
  } as unknown as MiniAppContext
}

/** Flush all pending microtasks. */
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── resolveNetworkType ───────────────────────────────────────────────────────

describe('resolveNetworkType', () => {
  it('returns "none" when onLine is false, regardless of type', () => {
    expect(resolveNetworkType({ onLine: false, type: 'wifi' })).toBe('none')
    expect(resolveNetworkType({ onLine: false })).toBe('none')
    expect(resolveNetworkType({ onLine: false, type: 'cellular', effectiveType: '4g' })).toBe('none')
  })

  it('returns "wifi" when type is "wifi"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'wifi' })).toBe('wifi')
  })

  it('returns "wifi" when type is "ethernet"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'ethernet' })).toBe('wifi')
  })

  it('maps cellular + effectiveType "4g" → "4g"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'cellular', effectiveType: '4g' })).toBe('4g')
  })

  it('maps cellular + effectiveType "3g" → "3g"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'cellular', effectiveType: '3g' })).toBe('3g')
  })

  it('maps cellular + effectiveType "2g" → "2g"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'cellular', effectiveType: '2g' })).toBe('2g')
  })

  it('maps cellular + effectiveType "slow-2g" → "2g"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'cellular', effectiveType: 'slow-2g' })).toBe('2g')
  })

  it('maps cellular + unknown effectiveType → "unknown"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'cellular', effectiveType: 'lte' })).toBe('unknown')
  })

  it('maps cellular with no effectiveType → "unknown"', () => {
    expect(resolveNetworkType({ onLine: true, type: 'cellular' })).toBe('unknown')
  })

  it('maps effectiveType "4g" with no type → "4g"', () => {
    expect(resolveNetworkType({ onLine: true, effectiveType: '4g' })).toBe('4g')
  })

  it('maps effectiveType "3g" with no type → "3g"', () => {
    expect(resolveNetworkType({ onLine: true, effectiveType: '3g' })).toBe('3g')
  })

  it('maps effectiveType "2g" with no type → "2g"', () => {
    expect(resolveNetworkType({ onLine: true, effectiveType: '2g' })).toBe('2g')
  })

  it('maps effectiveType "slow-2g" with no type → "2g"', () => {
    expect(resolveNetworkType({ onLine: true, effectiveType: 'slow-2g' })).toBe('2g')
  })

  it('maps unknown effectiveType with no type → "unknown"', () => {
    expect(resolveNetworkType({ onLine: true, effectiveType: 'nr' })).toBe('unknown')
  })

  it('returns "wifi" (devtools fallback) when onLine true with neither type nor effectiveType', () => {
    expect(resolveNetworkType({ onLine: true })).toBe('wifi')
  })
})

// ─── getClipboardData ─────────────────────────────────────────────────────────

describe('getClipboardData', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: { readText: vi.fn().mockResolvedValue('hello') },
    })
  })

  it('calls success with { data, errMsg } on resolve', async () => {
    const ctx = makeCtx()
    const success = vi.fn()
    const complete = vi.fn()
    await getClipboardData.call(ctx, { success, complete })
    await flush()
    expect(success).toHaveBeenCalledWith({ data: 'hello', errMsg: 'getClipboardData:ok' })
  })

  it('calls complete after success', async () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    await getClipboardData.call(ctx, { complete })
    await flush()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not call success before the promise resolves', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    getClipboardData.call(ctx, { success })
    // synchronously — promise not yet settled
    expect(success).not.toHaveBeenCalled()
  })

  it('calls fail (errMsg starts with getClipboardData:fail) on readText reject', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const ctx = makeCtx()
    const success = vi.fn()
    const fail = vi.fn()
    const complete = vi.fn()
    await getClipboardData.call(ctx, { success, fail, complete })
    await flush()
    expect(success).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    expect((fail.mock.calls[0][0] as { errMsg: string }).errMsg).toMatch(/^getClipboardData:fail/)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('calls complete even on reject', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const ctx = makeCtx()
    const complete = vi.fn()
    await getClipboardData.call(ctx, { complete })
    await flush()
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

// ─── setClipboardData ─────────────────────────────────────────────────────────

describe('setClipboardData', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    writeText.mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
  })

  it('calls fail with data-required errMsg when data is undefined', async () => {
    const ctx = makeCtx()
    const success = vi.fn()
    const fail = vi.fn()
    const complete = vi.fn()
    await setClipboardData.call(ctx, { success, fail, complete })
    await flush()
    expect(fail).toHaveBeenCalledWith({ errMsg: 'setClipboardData:fail data is required' })
    expect(success).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not call writeText when data is missing', async () => {
    const ctx = makeCtx()
    await setClipboardData.call(ctx, {})
    await flush()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('calls writeText with the provided data string', async () => {
    const ctx = makeCtx()
    await setClipboardData.call(ctx, { data: 'copied!' })
    await flush()
    expect(writeText).toHaveBeenCalledWith('copied!')
  })

  it('calls success with { errMsg: "setClipboardData:ok" } on writeText resolve', async () => {
    const ctx = makeCtx()
    const success = vi.fn()
    await setClipboardData.call(ctx, { data: 'text', success })
    await flush()
    expect(success).toHaveBeenCalledWith({ errMsg: 'setClipboardData:ok' })
  })

  it('calls complete after writeText resolves', async () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    await setClipboardData.call(ctx, { data: 'text', complete })
    await flush()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('calls fail (errMsg starts with setClipboardData:fail) on writeText reject', async () => {
    writeText.mockRejectedValue(new Error('write denied'))
    const ctx = makeCtx()
    const success = vi.fn()
    const fail = vi.fn()
    const complete = vi.fn()
    await setClipboardData.call(ctx, { data: 'text', success, fail, complete })
    await flush()
    expect(success).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    expect((fail.mock.calls[0][0] as { errMsg: string }).errMsg).toMatch(/^setClipboardData:fail/)
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

// ─── getNetworkType ───────────────────────────────────────────────────────────

describe('getNetworkType', () => {
  it('calls success with a non-"none" networkType when online', async () => {
    vi.stubGlobal('navigator', {
      onLine: true,
      connection: { type: 'wifi' },
    })
    const ctx = makeCtx()
    const success = vi.fn()
    const complete = vi.fn()
    await getNetworkType.call(ctx, { success, complete })
    await flush()
    expect(success).toHaveBeenCalledTimes(1)
    const payload = success.mock.calls[0][0] as { networkType: string; errMsg: string }
    expect(payload.errMsg).toBe('getNetworkType:ok')
    expect(payload.networkType).not.toBe('none')
  })

  it('calls success with networkType "none" when offline', async () => {
    vi.stubGlobal('navigator', {
      onLine: false,
    })
    const ctx = makeCtx()
    const success = vi.fn()
    await getNetworkType.call(ctx, { success })
    await flush()
    expect(success).toHaveBeenCalledTimes(1)
    const payload = success.mock.calls[0][0] as { networkType: string }
    expect(payload.networkType).toBe('none')
  })

  it('calls complete after success', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    const ctx = makeCtx()
    const complete = vi.fn()
    await getNetworkType.call(ctx, { complete })
    await flush()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('returns "4g" for cellular + effectiveType 4g', async () => {
    vi.stubGlobal('navigator', {
      onLine: true,
      connection: { type: 'cellular', effectiveType: '4g' },
    })
    const ctx = makeCtx()
    const success = vi.fn()
    await getNetworkType.call(ctx, { success })
    await flush()
    expect((success.mock.calls[0][0] as { networkType: string }).networkType).toBe('4g')
  })
})
