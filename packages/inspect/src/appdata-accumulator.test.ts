/**
 * Tests for AppDataAccumulator.pageData(bridgeId).
 *
 * Contract:
 *   - Returns a single shallow-merged object combining `entry.data` of EVERY
 *     cache entry whose key starts with `${bridgeId}/`.
 *   - Returns {} for an unknown bridgeId and after clearBridge(bridgeId).
 *   - Only that bridge's entries are merged (other bridgeIds excluded).
 *
 * These tests pin page reactive-data reads (miniprogram-automator Page.getData)
 * off the central accumulator.
 */
import { describe, expect, it } from 'vitest'
import { AppDataAccumulator } from './appdata-accumulator.js'

/** Apply a page-instance init (full initial state) for a bridge. */
function applyInit(
  acc: AppDataAccumulator,
  bridgeId: string,
  moduleId: string,
  componentPath: string,
  data: Record<string, unknown>,
): void {
  acc.apply({ mode: 'init', bridgeId, moduleId, componentPath, data })
}

/** Apply a setData patch (merge onto previous) for a bridge/module. */
function applyPatch(
  acc: AppDataAccumulator,
  bridgeId: string,
  moduleId: string,
  data: Record<string, unknown>,
): void {
  acc.apply({ mode: 'patch', bridgeId, moduleId, data })
}

describe('AppDataAccumulator.pageData', () => {
  it('merges init + setData patch into the current reactive state for the bridge', () => {
    const acc = new AppDataAccumulator()
    applyInit(acc, 'b1', 'page_1', 'pages/index/index', { count: 0, title: 'hi' })
    applyPatch(acc, 'b1', 'page_1', { count: 5 })

    // count reflects the patch; title survives from init (setData merge semantics)
    expect(acc.pageData('b1')).toEqual({ count: 5, title: 'hi' })
  })

  it('shallow-merges multiple page module entries belonging to the same bridge', () => {
    const acc = new AppDataAccumulator()
    applyInit(acc, 'b1', 'page_1', 'pages/index/index', { a: 1 })
    // A second page module on the same bridge contributes its own keys.
    applyInit(acc, 'b1', 'page_2', 'pages/index/index', { b: 2 })

    expect(acc.pageData('b1')).toEqual({ a: 1, b: 2 })
  })

  it('isolates bridges — only the requested bridge\'s entries are merged', () => {
    const acc = new AppDataAccumulator()
    applyInit(acc, 'b1', 'page_1', 'pages/index/index', { name: 'amy' })
    applyInit(acc, 'b2', 'page_1', 'pages/other/other', { name: 'bob' })
    applyPatch(acc, 'b2', 'page_1', { extra: true })

    expect(acc.pageData('b1')).toEqual({ name: 'amy' })
    expect(acc.pageData('b2')).toEqual({ name: 'bob', extra: true })
    // b1's result must not contain b2's keys.
    expect(acc.pageData('b1')).not.toHaveProperty('extra')
  })

  it('returns {} for an unknown bridgeId (no entries)', () => {
    const acc = new AppDataAccumulator()
    applyInit(acc, 'b1', 'page_1', 'pages/index/index', { count: 0 })

    expect(acc.pageData('does-not-exist')).toEqual({})
  })

  it('returns {} after clearBridge evicts the bridge', () => {
    const acc = new AppDataAccumulator()
    applyInit(acc, 'b1', 'page_1', 'pages/index/index', { count: 3 })
    expect(acc.pageData('b1')).toEqual({ count: 3 })

    acc.clearBridge('b1')
    expect(acc.pageData('b1')).toEqual({})
  })
})
