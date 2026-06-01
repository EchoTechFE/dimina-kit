import { describe, expect, it, vi } from 'vitest'
import { isTransientFsError, readWithRetry } from './retry'

/** Build an Error carrying a Node-style `code`. */
function codedError(code: string): Error {
  const err = new Error(code) as Error & { code?: string }
  err.code = code
  return err
}

describe('isTransientFsError', () => {
  it('treats ENOACTIVE (no active project yet) as transient', () => {
    expect(isTransientFsError(codedError('ENOACTIVE'))).toBe(true)
  })

  it('treats an ENOACTIVE message without a code as transient', () => {
    // `invokeStrict` rejects with an Error reconstructed from the main
    // process; the structured `code` may be lost across the IPC boundary,
    // leaving only the message text.
    expect(isTransientFsError(new Error('No active project — open a project'))).toBe(true)
  })

  it('does NOT treat ENOENT (missing file) as transient', () => {
    expect(isTransientFsError(codedError('ENOENT'))).toBe(false)
  })

  it('does NOT treat EACCES (escape / permission) as transient', () => {
    expect(isTransientFsError(codedError('EACCES'))).toBe(false)
  })

  it('does NOT treat EINVAL as transient', () => {
    expect(isTransientFsError(codedError('EINVAL'))).toBe(false)
  })
})

describe('readWithRetry', () => {
  it('returns immediately on first success without sleeping', async () => {
    const read = vi.fn().mockResolvedValue('content')
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await readWithRetry(read, {
      attempts: 12,
      delayMs: 300,
      isCancelled: () => false,
      sleep,
    })
    expect(result).toBe('content')
    expect(read).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries on transient ENOACTIVE then resolves with the eventual value', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(codedError('ENOACTIVE'))
      .mockRejectedValueOnce(codedError('ENOACTIVE'))
      .mockResolvedValue('content')
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await readWithRetry(read, {
      attempts: 12,
      delayMs: 300,
      isCancelled: () => false,
      sleep,
    })
    expect(result).toBe('content')
    expect(read).toHaveBeenCalledTimes(3)
    // Slept once between each of the two failed attempts.
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a non-transient error (ENOENT) — rethrows on first attempt', async () => {
    const read = vi.fn().mockRejectedValue(codedError('ENOENT'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(
      readWithRetry(read, {
        attempts: 12,
        delayMs: 300,
        isCancelled: () => false,
        sleep,
      }),
    ).rejects.toThrow('ENOENT')
    expect(read).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up after the bounded number of attempts and rethrows the last transient error', async () => {
    const read = vi.fn().mockRejectedValue(codedError('ENOACTIVE'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(
      readWithRetry(read, {
        attempts: 4,
        delayMs: 300,
        isCancelled: () => false,
        sleep,
      }),
    ).rejects.toThrow('ENOACTIVE')
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('aborts (resolves undefined) when cancelled before any read', async () => {
    const read = vi.fn().mockResolvedValue('content')
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await readWithRetry(read, {
      attempts: 12,
      delayMs: 300,
      isCancelled: () => true,
      sleep,
    })
    expect(result).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('stops retrying once cancelled mid-flight (seq/root changed)', async () => {
    let cancelled = false
    const read = vi.fn().mockRejectedValue(codedError('ENOACTIVE'))
    // Flip the cancel flag after the first failed attempt + sleep.
    const sleep = vi.fn().mockImplementation(async () => {
      cancelled = true
    })
    const result = await readWithRetry(read, {
      attempts: 12,
      delayMs: 300,
      isCancelled: () => cancelled,
      sleep,
    })
    expect(result).toBeUndefined()
    // One read, one sleep that set cancelled; the loop must bail before a 2nd read.
    expect(read).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})
