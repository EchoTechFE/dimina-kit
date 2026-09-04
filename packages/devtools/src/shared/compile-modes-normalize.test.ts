/**
 * `normalizeCompileModes` drops entries whose `pathName` isn't a string, but
 * `current` in the raw file is an index into the ORIGINAL (unfiltered) list.
 * Dropping entries shifts every later survivor down, so `current` must be
 * remapped to the survivor's new position — otherwise a saved selection can
 * silently point at a different mode than the one the file actually selected
 * (or at nothing, once entries shrink the list out from under a stale index).
 */
import { describe, it, expect } from 'vitest'
import { NORMAL_COMPILE_INDEX, normalizeCompileModes, resolveCompileConfig } from './compile-modes.js'

describe('normalizeCompileModes — current 在丢弃非法条目后必须重新映射到幸存条目', () => {
  it('current 指向幸存条目时，归一化后的下标必须跟随该条目在新列表中的位置，而不是原始下标', () => {
    const raw = {
      current: 1,
      list: [{ name: '坏的' }, { name: '好的', pathName: 'pages/a/a' }],
    }
    const result = normalizeCompileModes(raw)

    expect(result.list).toEqual([{ name: '好的', pathName: 'pages/a/a', query: '', scene: null }])
    expect(result.current, '唯一幸存的条目在新列表里的下标是 0').toBe(0)
    // 用户可见后果：resolveCompileConfig 拿到的 startPage 必须是幸存条目的页面，
    // 而不是因为下标错位（1 或被裁成 -1）退回普通编译。
    expect(resolveCompileConfig(result).startPage).toBe('pages/a/a')
  })

  it('current 指向的条目本身是非法条目时，退回普通编译（不是保留原下标，也不是指向其它幸存条目）', () => {
    const raw = {
      current: 0,
      list: [{ name: '坏的' }, { pathName: 'pages/a/a' }],
    }
    const result = normalizeCompileModes(raw)

    expect(result.current).toBe(NORMAL_COMPILE_INDEX)
    expect(result.list).toHaveLength(1)
  })

  it('current 之前有多个非法条目被丢弃时，下标按幸存条目的实际位置累计，而不是简单减一', () => {
    const raw = {
      current: 2,
      list: [{ name: '坏1' }, { name: '坏2' }, { name: '好的', pathName: 'pages/c/c' }],
    }
    const result = normalizeCompileModes(raw)

    expect(result.current).toBe(0)
    expect(result.list).toEqual([{ name: '好的', pathName: 'pages/c/c', query: '', scene: null }])
  })
})
