/**
 * Unit tests for `useLayoutStore`.
 *
 * Public contract under test (see ./use-layout-store.ts):
 * - Hydrates from `localStorage['dimina-devtools.layout.v1']`, falling back to
 *   DEFAULT_LAYOUT_STATE on any corruption / missing / wrong-typed value.
 * - Enforces the "at least one panel visible" invariant when toggling and when
 *   loading a persisted all-hidden state.
 * - Persists every state change back to localStorage, but never throws if the
 *   write fails (quota / disabled storage).
 * - Toggling visibility and changing alignment / devtools position update state
 *   and persist.
 *
 * These tests use jsdom's real `window.localStorage`, cleared between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useLayoutStore, DEFAULT_LAYOUT_STATE } from './use-layout-store'

const STORAGE_KEY = 'dimina-devtools.layout.v1'

function persisted(): unknown {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw == null ? null : JSON.parse(raw)
}

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useLayoutStore — hydration / sanitization', () => {
  // Regression: a corrupt JSON blob in localStorage must not crash the hook on
  // mount; it has to silently fall back to defaults. A naive `JSON.parse`
  // without try/catch would throw during render and white-screen the app.
  it('falls back to default state when localStorage holds invalid JSON (no throw)', () => {
    window.localStorage.setItem(STORAGE_KEY, '{ this is : not json ]')

    let result: ReturnType<typeof renderHook<ReturnType<typeof useLayoutStore>, unknown>>['result']
    expect(() => {
      ;({ result } = renderHook(() => useLayoutStore()))
    }).not.toThrow()

    expect(result!.current.state).toEqual(DEFAULT_LAYOUT_STATE)
  })

  // Regression: a persisted object missing some keys (e.g. written by an older
  // build that didn't have `devtoolsPosition`) must fill the gaps from defaults
  // field-by-field, not wipe the whole thing and not leave `undefined` fields.
  it('fills missing fields from defaults while keeping present valid fields', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ simulatorVisible: false, editorVisible: true }),
    )

    const { result } = renderHook(() => useLayoutStore())

    expect(result.current.state).toEqual({
      simulatorVisible: false, // present + valid → kept
      editorVisible: true, // present + valid → kept (also keeps invariant satisfied)
      debugVisible: DEFAULT_LAYOUT_STATE.debugVisible, // missing → default
      simulatorAlignment: DEFAULT_LAYOUT_STATE.simulatorAlignment, // missing → default
      devtoolsPosition: DEFAULT_LAYOUT_STATE.devtoolsPosition, // missing → default
    })
  })

  // Regression: a stored value with wrong-typed / out-of-range fields (booleans
  // as strings, an unknown alignment / position enum) must be rejected per field
  // and replaced with the default, never passed through verbatim into state.
  it('rejects wrong-typed and out-of-enum fields, replacing each with its default', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        simulatorVisible: 'yes', // wrong type → default (true)
        editorVisible: 0, // wrong type → default (true)
        debugVisible: false, // valid → kept (and keeps invariant satisfied)
        simulatorAlignment: 'middle', // not in enum → default ('left')
        devtoolsPosition: 'floating', // not in enum → default ('inEditor')
      }),
    )

    const { result } = renderHook(() => useLayoutStore())

    expect(result.current.state).toEqual({
      simulatorVisible: DEFAULT_LAYOUT_STATE.simulatorVisible,
      editorVisible: DEFAULT_LAYOUT_STATE.editorVisible,
      debugVisible: false,
      simulatorAlignment: DEFAULT_LAYOUT_STATE.simulatorAlignment,
      devtoolsPosition: DEFAULT_LAYOUT_STATE.devtoolsPosition,
    })
  })

  // Regression: a persisted state where every panel is hidden (a stale write or
  // hand-edit) would render an empty window. Loading it must be sanitized back
  // to the full default layout, never produce a zero-visible-panel state.
  it('sanitizes a persisted all-hidden layout back to defaults', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        simulatorVisible: false,
        editorVisible: false,
        debugVisible: false,
        simulatorAlignment: 'right',
        devtoolsPosition: 'belowSimulator',
      }),
    )

    const { result } = renderHook(() => useLayoutStore())

    // Whole state reset to default (not just the visibility flags) because the
    // implementation returns DEFAULT_LAYOUT_STATE wholesale in this case.
    expect(result.current.state).toEqual(DEFAULT_LAYOUT_STATE)
    expect(result.current.visibleCount).toBe(3)
  })

  // Regression: valid persisted state must round-trip exactly — guards against a
  // hydration bug that would over-sanitize and discard legitimate user choices.
  it('hydrates a fully-valid persisted state verbatim', () => {
    const stored = {
      simulatorVisible: true,
      editorVisible: false,
      debugVisible: true,
      simulatorAlignment: 'right' as const,
      devtoolsPosition: 'rightOfSimulator' as const,
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

    const { result } = renderHook(() => useLayoutStore())

    expect(result.current.state).toEqual(stored)
  })
})

describe('useLayoutStore — at-least-one-visible invariant', () => {
  // Regression: when exactly one panel remains visible, toggling THAT panel off
  // must be a no-op (state identity unchanged). Removing the guard would let the
  // window go fully blank with no way to recover via the toolbar.
  it('rejects toggling off the last remaining visible panel (state unchanged)', () => {
    // Start with only the simulator visible.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        simulatorVisible: true,
        editorVisible: false,
        debugVisible: false,
      }),
    )

    const { result } = renderHook(() => useLayoutStore())
    expect(result.current.visibleCount).toBe(1)
    expect(result.current.state.simulatorVisible).toBe(true)

    const before = result.current.state
    act(() => {
      result.current.toggleSimulator()
    })

    // Toggle was rejected → still visible, and the count never dropped to 0.
    expect(result.current.state.simulatorVisible).toBe(true)
    expect(result.current.visibleCount).toBe(1)
    // Implementation returns the previous object reference unchanged.
    expect(result.current.state).toBe(before)
  })

  // Regression: the guard must only block the *last* panel — toggling off a
  // non-last visible panel must still work and bring visibleCount down to 1.
  it('allows toggling off a panel while another stays visible', () => {
    // simulator + editor visible, debug hidden.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        simulatorVisible: true,
        editorVisible: true,
        debugVisible: false,
      }),
    )

    const { result } = renderHook(() => useLayoutStore())
    expect(result.current.visibleCount).toBe(2)

    act(() => {
      result.current.toggleEditor()
    })

    expect(result.current.state.editorVisible).toBe(false)
    expect(result.current.state.simulatorVisible).toBe(true)
    expect(result.current.visibleCount).toBe(1)

    // Now editor is hidden and simulator is the last one — toggling simulator is rejected.
    act(() => {
      result.current.toggleSimulator()
    })
    expect(result.current.state.simulatorVisible).toBe(true)
    expect(result.current.visibleCount).toBe(1)
  })
})

describe('useLayoutStore — toggles and persistence', () => {
  // Regression: toggling a panel visible/hidden must both update state and be
  // written back to localStorage, so the choice survives a reload. A missing
  // persistence effect would silently drop the change on next mount.
  it('toggles visibility and persists the new state', () => {
    const { result } = renderHook(() => useLayoutStore())
    // Default has all three visible.
    expect(result.current.state.debugVisible).toBe(true)

    act(() => {
      result.current.toggleDebug()
    })

    expect(result.current.state.debugVisible).toBe(false)
    expect(persisted()).toMatchObject({ debugVisible: false })
  })

  // Regression: changing alignment / devtools position must update state and
  // persist; setting the same value must be a no-op (identity preserved) so we
  // don't trigger redundant re-renders or writes.
  it('updates and persists simulatorAlignment and devtoolsPosition', () => {
    const { result } = renderHook(() => useLayoutStore())
    expect(result.current.state.simulatorAlignment).toBe('left')
    expect(result.current.state.devtoolsPosition).toBe('inEditor')

    act(() => {
      result.current.setSimulatorAlignment('right')
    })
    expect(result.current.state.simulatorAlignment).toBe('right')
    expect(persisted()).toMatchObject({ simulatorAlignment: 'right' })

    act(() => {
      result.current.setDevtoolsPosition('belowSimulator')
    })
    expect(result.current.state.devtoolsPosition).toBe('belowSimulator')
    expect(persisted()).toMatchObject({ devtoolsPosition: 'belowSimulator' })

    // Setting the same value again returns the same state object (no-op).
    const before = result.current.state
    act(() => {
      result.current.setSimulatorAlignment('right')
    })
    expect(result.current.state).toBe(before)
  })

  // Regression: if localStorage.setItem throws (quota exceeded / storage
  // disabled), the write must be swallowed — the in-memory state update still
  // applies and the hook must not throw, keeping the UI responsive offline.
  it('swallows localStorage write failures while still applying the state update', () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      })

    const { result } = renderHook(() => useLayoutStore())
    expect(result.current.state.editorVisible).toBe(true)

    expect(() => {
      act(() => {
        result.current.toggleEditor()
      })
    }).not.toThrow()

    // State update still took effect even though persistence failed.
    expect(result.current.state.editorVisible).toBe(false)
    expect(setItemSpy).toHaveBeenCalled()
  })
})
