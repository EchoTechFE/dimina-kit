/**
 * applyHostEnvUpdate: the service-host preload's handling of a `hostEnvUpdate`
 * message on the ordinary `TO_SERVICE` pipe. It shallow-merges
 * `body.systemInfo` into `ctx.hostEnvSnapshot` (what the patched sync
 * `wx.getSystemInfoSync()` reads on every call) and reports whether it
 * applied. Never throws: a message of the wrong shape, or no ctx, both
 * resolve to `false` and leave the snapshot untouched.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applyHostEnvUpdate } = require('./host-env-update.cjs') as {
  applyHostEnvUpdate: (
    ctx: { hostEnvSnapshot: Record<string, unknown> | null } | null,
    msg: unknown,
  ) => boolean
}

function updateMsg(systemInfo: unknown) {
  return { type: 'hostEnvUpdate', target: 'service', body: { systemInfo } }
}

describe('applyHostEnvUpdate', () => {
  it('merges systemInfo into an existing snapshot and returns true', () => {
    const ctx = { hostEnvSnapshot: { windowWidth: 375, windowHeight: 812, platform: 'ios' } }

    const result = applyHostEnvUpdate(ctx, updateMsg({ windowWidth: 430, windowHeight: 932 }))

    expect(result).toBe(true)
    expect(ctx.hostEnvSnapshot).toEqual({ windowWidth: 430, windowHeight: 932, platform: 'ios' })
  })

  it('sets the snapshot to a copy of systemInfo when there was none yet', () => {
    const ctx = { hostEnvSnapshot: null }
    const systemInfo = { windowWidth: 390, windowHeight: 844 }

    const result = applyHostEnvUpdate(ctx, updateMsg(systemInfo))

    expect(result).toBe(true)
    expect(ctx.hostEnvSnapshot).toEqual(systemInfo)
    expect(ctx.hostEnvSnapshot).not.toBe(systemInfo)
  })

  it('returns false and leaves the snapshot untouched for a non-hostEnvUpdate message', () => {
    const ctx = { hostEnvSnapshot: { windowWidth: 375 } }

    const result = applyHostEnvUpdate(ctx, {
      type: 'other',
      target: 'service',
      body: { systemInfo: { windowWidth: 430 } },
    })

    expect(result).toBe(false)
    expect(ctx.hostEnvSnapshot).toEqual({ windowWidth: 375 })
  })

  it('returns false when body has no systemInfo', () => {
    const ctx = { hostEnvSnapshot: { windowWidth: 375 } }

    expect(applyHostEnvUpdate(ctx, { type: 'hostEnvUpdate', target: 'service', body: {} })).toBe(false)
    expect(applyHostEnvUpdate(ctx, { type: 'hostEnvUpdate', target: 'service', body: null })).toBe(false)
    expect(ctx.hostEnvSnapshot).toEqual({ windowWidth: 375 })
  })

  it('returns false when systemInfo is not a plain object', () => {
    const ctx = { hostEnvSnapshot: { windowWidth: 375 } }

    for (const bad of [null, 'nope', 42, true]) {
      expect(applyHostEnvUpdate(ctx, updateMsg(bad))).toBe(false)
    }
    expect(ctx.hostEnvSnapshot).toEqual({ windowWidth: 375 })
  })

  it('returns false (not throw) for a null message or a null ctx', () => {
    const ctx = { hostEnvSnapshot: { windowWidth: 375 } }

    expect(() => applyHostEnvUpdate(ctx, null)).not.toThrow()
    expect(applyHostEnvUpdate(ctx, null)).toBe(false)
    expect(ctx.hostEnvSnapshot).toEqual({ windowWidth: 375 })

    expect(applyHostEnvUpdate(null, updateMsg({ windowWidth: 430 }))).toBe(false)
  })
})
