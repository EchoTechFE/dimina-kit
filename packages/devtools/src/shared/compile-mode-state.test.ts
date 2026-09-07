/**
 * `compile-mode-state.ts` is the new in-memory model for compile modes:
 * selection tracks a minted id, not an index into `list`. `stateFromStored`/
 * `storedFromState` are the only two places index arithmetic is allowed to
 * happen at all — everywhere else (in particular `applyCompileModeCommand`)
 * only ever compares/reassigns ids.
 *
 * Design: /Volumes/jdisk/code/dimina-kit-docs/compile-mode-store-design.md §2.1/§2.2
 */
import { describe, it, expect } from 'vitest'
import {
  applyCompileModeCommand,
  emptyCompileModeState,
  selectedMode,
  stateFromStored,
  storedFromState,
  type CompileModeState,
} from './compile-mode-state.js'
import { NORMAL_COMPILE_INDEX, normalizeCompileModes } from './compile-modes.js'
import type { CompileMode } from './types.js'

function makeMintId(prefix = 'id') {
  let n = 0
  return () => `${prefix}-${++n}`
}

const modeA: CompileMode = { name: 'A', pathName: 'pages/a/a', query: '', scene: null }
const modeB: CompileMode = { name: 'B', pathName: 'pages/b/b', query: 'x=1', scene: 1001 }
const modeC: CompileMode = { name: 'C', pathName: 'pages/c/c', query: '', scene: null }

// ── emptyCompileModeState ────────────────────────────────────────────────

describe('emptyCompileModeState', () => {
  it('has no entries and selects nothing (普通编译)', () => {
    expect(emptyCompileModeState()).toEqual({ selectedId: null, entries: [] })
  })
})

// ── stateFromStored ──────────────────────────────────────────────────────

describe('stateFromStored', () => {
  it('mints an id for each surviving entry, in list order', () => {
    const mintId = makeMintId()
    const state = stateFromStored(
      { current: NORMAL_COMPILE_INDEX, list: [modeA, modeB] },
      mintId,
    )
    expect(state.entries).toEqual([
      { id: 'id-1', mode: modeA },
      { id: 'id-2', mode: modeB },
    ])
  })

  it('selects null when the stored current is -1 (普通编译)', () => {
    const state = stateFromStored({ current: NORMAL_COMPILE_INDEX, list: [modeA] }, makeMintId())
    expect(state.selectedId).toBeNull()
  })

  it('selects the entry whose position matches the stored current', () => {
    const state = stateFromStored({ current: 1, list: [modeA, modeB] }, makeMintId())
    expect(state.selectedId).toBe(state.entries[1].id)
  })

  it('falls back to the empty state for malformed raw input (delegates to normalizeCompileModes)', () => {
    expect(stateFromStored(undefined, makeMintId())).toEqual(emptyCompileModeState())
    expect(stateFromStored('not an object', makeMintId())).toEqual(emptyCompileModeState())
  })

  // 原③: a corrupt entry dropped from the raw list shifts every later index
  // down (normalizeCompileModes' own remap), but the SELECTED ENTRY'S DATA
  // must still be the one the file named — not whichever entry now happens
  // to sit at the old numeric position.
  it('keeps selecting the same entry by identity when an earlier corrupt entry is dropped', () => {
    const raw = {
      current: 2, // raw.list[2] = modeB, before the drop
      list: [null, modeA, modeB],
    }
    const state = stateFromStored(raw, makeMintId())
    expect(state.entries.map((e) => e.mode)).toEqual([modeA, modeB])
    const selected = state.entries.find((e) => e.id === state.selectedId)
    expect(
      selected?.mode,
      'selection must track modeB (what raw.current actually pointed at), not modeA (whatever now sits at index 1)',
    ).toEqual(modeB)
  })
})

// ── storedFromState ──────────────────────────────────────────────────────

describe('storedFromState', () => {
  it('stores current: -1 when nothing is selected', () => {
    const state: CompileModeState = { selectedId: null, entries: [{ id: 'x', mode: modeA }] }
    expect(storedFromState(state).current).toBe(NORMAL_COMPILE_INDEX)
  })

  it('stores the position of the selected entry as current', () => {
    const state: CompileModeState = {
      selectedId: 'b',
      entries: [{ id: 'a', mode: modeA }, { id: 'b', mode: modeB }],
    }
    expect(storedFromState(state)).toEqual({ current: 1, list: [modeA, modeB] })
  })

  it('round-trips through stateFromStored back to normalizeCompileModes(raw) — the boundary invariant', () => {
    const raw = { current: 1, list: [modeA, modeB, modeC] }
    const roundTripped = storedFromState(stateFromStored(raw, makeMintId()))
    expect(roundTripped).toEqual(normalizeCompileModes(raw))
  })
})

// ── selectedMode ─────────────────────────────────────────────────────────

describe('selectedMode', () => {
  it('returns null when selectedId is null', () => {
    expect(selectedMode({ selectedId: null, entries: [{ id: 'a', mode: modeA }] })).toBeNull()
  })

  it('returns the mode of the entry matching selectedId', () => {
    const state: CompileModeState = {
      selectedId: 'b',
      entries: [{ id: 'a', mode: modeA }, { id: 'b', mode: modeB }],
    }
    expect(selectedMode(state)).toEqual(modeB)
  })

  it('returns null when selectedId does not match any entry (defensive — should not occur via applyCompileModeCommand)', () => {
    const state: CompileModeState = { selectedId: 'ghost', entries: [{ id: 'a', mode: modeA }] }
    expect(selectedMode(state)).toBeNull()
  })
})

// ── applyCompileModeCommand — one case per command-table row ────────────

describe('applyCompileModeCommand', () => {
  it('select null: deselects (普通编译), relaunch=true', () => {
    const state: CompileModeState = { selectedId: 'a', entries: [{ id: 'a', mode: modeA }] }
    const result = applyCompileModeCommand(state, { type: 'select', id: null }, makeMintId())
    expect(result.state.selectedId).toBeNull()
    expect(result.relaunch).toBe(true)
  })

  it('select id (found): selects it, relaunch=true even when it was already selected', () => {
    const state: CompileModeState = {
      selectedId: 'a',
      entries: [{ id: 'a', mode: modeA }, { id: 'b', mode: modeB }],
    }
    const reselectSame = applyCompileModeCommand(state, { type: 'select', id: 'a' }, makeMintId())
    expect(reselectSame.state.selectedId).toBe('a')
    expect(reselectSame.relaunch, 're-selecting the already-selected mode still relaunches').toBe(true)

    const selectOther = applyCompileModeCommand(state, { type: 'select', id: 'b' }, makeMintId())
    expect(selectOther.state.selectedId).toBe('b')
    expect(selectOther.relaunch).toBe(true)
  })

  it('select id (not found): no-op — returns the SAME state reference, relaunch=false', () => {
    const state: CompileModeState = { selectedId: 'a', entries: [{ id: 'a', mode: modeA }] }
    const result = applyCompileModeCommand(state, { type: 'select', id: 'ghost' }, makeMintId())
    expect(result.state).toBe(state)
    expect(result.relaunch).toBe(false)
  })

  it('add: appends a freshly minted entry and selects it, relaunch=true', () => {
    const state: CompileModeState = { selectedId: null, entries: [] }
    const result = applyCompileModeCommand(state, { type: 'add', mode: modeA }, makeMintId('new'))
    expect(result.state.entries).toEqual([{ id: 'new-1', mode: modeA }])
    expect(result.state.selectedId).toBe('new-1')
    expect(result.relaunch).toBe(true)
  })

  it('update id (found), not the selected one: swaps the mode in place, keeps the id, relaunch=false', () => {
    const state: CompileModeState = {
      selectedId: null,
      entries: [{ id: 'a', mode: modeA }],
    }
    const result = applyCompileModeCommand(state, { type: 'update', id: 'a', mode: modeB }, makeMintId())
    expect(result.state.entries).toEqual([{ id: 'a', mode: modeB }])
    expect(result.relaunch).toBe(false)
  })

  it('update id (found), IS the selected one: swaps the mode, relaunch=true', () => {
    const state: CompileModeState = {
      selectedId: 'a',
      entries: [{ id: 'a', mode: modeA }],
    }
    const result = applyCompileModeCommand(state, { type: 'update', id: 'a', mode: modeB }, makeMintId())
    expect(result.state.entries).toEqual([{ id: 'a', mode: modeB }])
    expect(result.state.selectedId).toBe('a')
    expect(result.relaunch).toBe(true)
  })

  it('update id (not found): treated as add — mints a new entry and selects it, relaunch=true', () => {
    const state: CompileModeState = {
      selectedId: null,
      entries: [{ id: 'a', mode: modeA }],
    }
    const result = applyCompileModeCommand(
      state,
      { type: 'update', id: 'ghost', mode: modeB },
      makeMintId('new'),
    )
    expect(result.state.entries).toEqual([
      { id: 'a', mode: modeA },
      { id: 'new-1', mode: modeB },
    ])
    expect(result.state.selectedId).toBe('new-1')
    expect(result.relaunch).toBe(true)
  })

  it('remove id, is selected: removes it and falls back to 普通编译, relaunch=true', () => {
    const state: CompileModeState = {
      selectedId: 'a',
      entries: [{ id: 'a', mode: modeA }, { id: 'b', mode: modeB }],
    }
    const result = applyCompileModeCommand(state, { type: 'remove', id: 'a' }, makeMintId())
    expect(result.state.entries).toEqual([{ id: 'b', mode: modeB }])
    expect(result.state.selectedId).toBeNull()
    expect(result.relaunch).toBe(true)
  })

  it('remove id, not selected: removes it, selection is untouched, relaunch=false', () => {
    const state: CompileModeState = {
      selectedId: 'b',
      entries: [{ id: 'a', mode: modeA }, { id: 'b', mode: modeB }],
    }
    const result = applyCompileModeCommand(state, { type: 'remove', id: 'a' }, makeMintId())
    expect(result.state.entries).toEqual([{ id: 'b', mode: modeB }])
    expect(result.state.selectedId).toBe('b')
    expect(result.relaunch).toBe(false)
  })

  it('remove id (not found): no-op — returns the SAME state reference, relaunch=false', () => {
    const state: CompileModeState = { selectedId: 'a', entries: [{ id: 'a', mode: modeA }] }
    const result = applyCompileModeCommand(state, { type: 'remove', id: 'ghost' }, makeMintId())
    expect(result.state).toBe(state)
    expect(result.relaunch).toBe(false)
  })

  // 原②: selecting the 3rd of 3 entries and then removing the 1st must leave
  // the SAME mode selected (by identity), and the persisted `current` must
  // point at that survivor's new position — not at a stale numeric index
  // left over from before the removal.
  it('regression: removing an earlier, unselected entry keeps the later selection on the same mode', () => {
    const mintId = makeMintId()
    const seeded: CompileModeState = {
      selectedId: null,
      entries: [
        { id: mintId(), mode: modeA },
        { id: mintId(), mode: modeB },
        { id: mintId(), mode: modeC },
      ],
    }
    const thirdId = seeded.entries[2].id
    const selected = applyCompileModeCommand(seeded, { type: 'select', id: thirdId }, mintId)
    expect(selected.state.selectedId).toBe(thirdId)

    const firstId = seeded.entries[0].id
    const afterRemove = applyCompileModeCommand(selected.state, { type: 'remove', id: firstId }, mintId)

    expect(
      selectedMode(afterRemove.state),
      'the 3rd entry (modeC) must still be selected — its id never changed',
    ).toEqual(modeC)
    expect(afterRemove.relaunch, 'removing an unselected entry must not relaunch').toBe(false)
    expect(
      storedFromState(afterRemove.state).current,
      'modeC now sits at position 1 in the surviving [modeB, modeC] list',
    ).toBe(1)
  })
})
