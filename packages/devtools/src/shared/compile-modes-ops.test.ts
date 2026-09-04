import { describe, it, expect } from 'vitest'
import {
  NORMAL_COMPILE_INDEX,
  removeCompileMode,
  resolveCompileConfig,
  selectCompileMode,
  upsertCompileMode,
} from './compile-modes.js'
import type { CompileMode, CompileModes } from './types.js'

// ── test data helpers ────────────────────────────────────────────────────────

function makeMode(overrides: Partial<CompileMode> = {}): CompileMode {
  return {
    name: overrides.name ?? 'mode',
    pathName: overrides.pathName ?? 'pages/index/index',
    query: overrides.query ?? '',
    scene: overrides.scene ?? null,
    ...overrides,
  }
}

function makeModes(list: CompileMode[], current: number): CompileModes {
  return { current, list }
}

// ── selectCompileMode ────────────────────────────────────────────────────────

describe('selectCompileMode', () => {
  it('selects a valid index, leaving the list untouched', () => {
    const list = [makeMode({ name: 'a' }), makeMode({ name: 'b' })]
    const modes = makeModes(list, 0)
    const result = selectCompileMode(modes, 1)
    expect(result.current).toBe(1)
    expect(result.list).toEqual(list)
  })

  it('selects 普通编译 via NORMAL_COMPILE_INDEX', () => {
    const modes = makeModes([makeMode()], 0)
    const result = selectCompileMode(modes, NORMAL_COMPILE_INDEX)
    expect(result.current).toBe(-1)
  })

  it('falls back to 普通编译 when the index is out of range, never pointing at a missing entry', () => {
    const modes = makeModes([makeMode()], 0)
    expect(selectCompileMode(modes, 5).current).toBe(NORMAL_COMPILE_INDEX)
    expect(selectCompileMode(modes, -2).current).toBe(NORMAL_COMPILE_INDEX)
  })

  it('does not mutate the input modes object or its list', () => {
    const list = [makeMode({ name: 'a' })]
    const modes = makeModes(list, NORMAL_COMPILE_INDEX)
    const snapshotModes = JSON.parse(JSON.stringify(modes))
    selectCompileMode(modes, 0)
    expect(modes).toEqual(snapshotModes)
    expect(modes.list).toBe(list)
  })
})

// ── upsertCompileMode ────────────────────────────────────────────────────────

describe('upsertCompileMode', () => {
  it('with index null, appends and selects the new mode, and requests a relaunch', () => {
    const modes = makeModes([makeMode({ name: 'a' })], 0)
    const newMode = makeMode({ name: 'new' })
    const { modes: result, relaunch } = upsertCompileMode(modes, null, newMode)
    expect(result.list).toHaveLength(2)
    expect(result.list[1]).toEqual(newMode)
    expect(result.current).toBe(1)
    expect(relaunch).toBe(true)
  })

  it('replacing the currently selected index keeps current unchanged and requests a relaunch', () => {
    const modes = makeModes([makeMode({ name: 'a' }), makeMode({ name: 'b' })], 1)
    const replacement = makeMode({ name: 'b2' })
    const { modes: result, relaunch } = upsertCompileMode(modes, 1, replacement)
    expect(result.list[1]).toEqual(replacement)
    expect(result.current).toBe(1)
    expect(relaunch).toBe(true)
  })

  it('replacing an index other than current keeps current unchanged and does not request a relaunch', () => {
    const modes = makeModes([makeMode({ name: 'a' }), makeMode({ name: 'b' })], 1)
    const replacement = makeMode({ name: 'a2' })
    const { modes: result, relaunch } = upsertCompileMode(modes, 0, replacement)
    expect(result.list[0]).toEqual(replacement)
    expect(result.current).toBe(1)
    expect(relaunch).toBe(false)
  })

  it('an out-of-range index (not null) is treated as an append, never leaving a sparse/undefined hole', () => {
    const modes = makeModes([makeMode({ name: 'a' })], 0)
    const newMode = makeMode({ name: 'appended' })
    const { modes: result, relaunch } = upsertCompileMode(modes, 9, newMode)
    expect(result.list).toHaveLength(2)
    expect(result.list.every((m) => m !== undefined)).toBe(true)
    expect(result.list[1]).toEqual(newMode)
    expect(result.current).toBe(1)
    expect(relaunch).toBe(true)
  })

  it('does not mutate the input modes object or its list', () => {
    const list = [makeMode({ name: 'a' })]
    const modes = makeModes(list, 0)
    const snapshotModes = JSON.parse(JSON.stringify(modes))
    upsertCompileMode(modes, 0, makeMode({ name: 'changed' }))
    expect(modes).toEqual(snapshotModes)
    expect(modes.list).toBe(list)
  })
})

// ── removeCompileMode ────────────────────────────────────────────────────────

describe('removeCompileMode', () => {
  it('removing the currently selected mode drops it and falls back to 普通编译, requesting a relaunch', () => {
    const modes = makeModes([makeMode({ name: 'a' }), makeMode({ name: 'b' })], 1)
    const { modes: result, relaunch } = removeCompileMode(modes, 1)
    expect(result.list).toHaveLength(1)
    expect(result.list.find((m) => m.name === 'b')).toBeUndefined()
    expect(result.current).toBe(NORMAL_COMPILE_INDEX)
    expect(relaunch).toBe(true)
  })

  it('removing an entry before current shifts current down but keeps it pointing at the same mode, no relaunch', () => {
    const selected = makeMode({ name: 'selected', pathName: 'pages/selected/index', query: 'a=1' })
    const modes = makeModes([makeMode({ name: 'before' }), selected], 1)
    const before = resolveCompileConfig(modes)
    const { modes: result, relaunch } = removeCompileMode(modes, 0)
    expect(result.current).toBe(0)
    const after = resolveCompileConfig(result)
    expect(after).toEqual(before)
    expect(relaunch).toBe(false)
  })

  it('removing an entry after current leaves current unchanged, no relaunch', () => {
    const modes = makeModes([makeMode({ name: 'a' }), makeMode({ name: 'b' }), makeMode({ name: 'c' })], 0)
    const { modes: result, relaunch } = removeCompileMode(modes, 2)
    expect(result.current).toBe(0)
    expect(result.list).toHaveLength(2)
    expect(relaunch).toBe(false)
  })

  it('removing any entry while 普通编译 is selected leaves current at -1, no relaunch', () => {
    const modes = makeModes([makeMode({ name: 'a' }), makeMode({ name: 'b' })], NORMAL_COMPILE_INDEX)
    const { modes: result, relaunch } = removeCompileMode(modes, 0)
    expect(result.current).toBe(NORMAL_COMPILE_INDEX)
    expect(relaunch).toBe(false)
  })

  it('an out-of-range index leaves the list and current untouched, no relaunch', () => {
    const list = [makeMode({ name: 'a' })]
    const modes = makeModes(list, 0)
    const { modes: result, relaunch } = removeCompileMode(modes, 5)
    expect(result.list).toEqual(list)
    expect(result.current).toBe(0)
    expect(relaunch).toBe(false)
  })

  it('does not mutate the input modes object or its list', () => {
    const list = [makeMode({ name: 'a' }), makeMode({ name: 'b' })]
    const modes = makeModes(list, 1)
    const snapshotModes = JSON.parse(JSON.stringify(modes))
    removeCompileMode(modes, 0)
    expect(modes).toEqual(snapshotModes)
    expect(modes.list).toBe(list)
  })
})
