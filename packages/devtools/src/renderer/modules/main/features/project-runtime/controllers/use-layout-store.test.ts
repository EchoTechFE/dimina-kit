/**
 * Unit tests for `useLayoutStore` (dock-only).
 *
 * After the layout consolidation the store holds a SINGLE opaque field —
 * `dockTree` (serialized DockView layout) — and nothing else. The legacy
 * visibility / alignment / devtools-position / dockableMode state (and its
 * at-least-one-visible sanitize) was removed with the FrameTree layout it drove,
 * so the tests that pinned that behavior were removed (the guarded behavior no
 * longer exists — they were not relaxed to keep passing).
 *
 * Public contract under test (see ./use-layout-store.ts):
 * - Hydrates `dockTree` from `localStorage['dimina-devtools.layout.v1']`,
 *   falling back to DEFAULT_LAYOUT_STATE (`dockTree: null`) on missing / corrupt
 *   / wrong-typed input.
 * - `setDockTree` updates state and persists; setting the same value is a no-op
 *   (identity preserved); a write failure is swallowed.
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

  // Regression: missing `dockTree` (e.g. a first run, or an older build that did
  // not persist it) must fall back to the default `null`, not leave it undefined.
  it('defaults dockTree to null when the persisted blob omits it', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({}))

    const { result } = renderHook(() => useLayoutStore())

    expect(result.current.state).toEqual({ dockTree: null })
  })

  // Regression: a wrong-typed `dockTree` (a number / object instead of the
  // opaque serialized string) must be rejected and replaced with null, never
  // passed through to `buildDockModel` (which would mis-parse it).
  it('rejects a non-string dockTree, replacing it with null', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ dockTree: 123 }))

    const { result } = renderHook(() => useLayoutStore())

    expect(result.current.state).toEqual({ dockTree: null })
  })

  // Regression: a valid persisted dockTree string must round-trip verbatim —
  // guards against a hydration bug that would discard the user's saved layout.
  it('hydrates a persisted dockTree string verbatim', () => {
    const stored = { dockTree: '{"version":1,"root":{"kind":"tabs","id":"g","panels":["editor"],"active":"editor"}}' }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

    const { result } = renderHook(() => useLayoutStore())

    expect(result.current.state).toEqual(stored)
  })
})

describe('useLayoutStore — setDockTree and persistence', () => {
  // Regression: persisting a dock tree must update state AND write to
  // localStorage so the layout survives a reload. A missing persistence effect
  // would silently drop the saved layout on next mount.
  it('persists a new dockTree and writes it to localStorage', () => {
    const { result } = renderHook(() => useLayoutStore())
    expect(result.current.state.dockTree).toBeNull()

    const tree = '{"version":1,"root":{"kind":"tabs","id":"g","panels":["editor"],"active":"editor"}}'
    act(() => {
      result.current.setDockTree(tree)
    })

    expect(result.current.state.dockTree).toBe(tree)
    expect(persisted()).toMatchObject({ dockTree: tree })
  })

  // Regression: setting the SAME serialized value must be a no-op (identity
  // preserved) so the model's persist-subscription re-emitting an unchanged tree
  // does not trigger a redundant re-render / write loop.
  it('returns the same state object when the dockTree value is unchanged', () => {
    const tree = '{"version":1,"root":{"kind":"tabs","id":"g","panels":["editor"],"active":"editor"}}'
    const { result } = renderHook(() => useLayoutStore())

    act(() => {
      result.current.setDockTree(tree)
    })
    const before = result.current.state

    act(() => {
      result.current.setDockTree(tree)
    })
    expect(result.current.state).toBe(before)
  })

  // Regression: if localStorage.setItem throws (quota / disabled storage), the
  // write must be swallowed — the in-memory state update still applies and the
  // hook must not throw, keeping the UI responsive offline.
  it('swallows localStorage write failures while still applying the state update', () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      })

    const { result } = renderHook(() => useLayoutStore())
    const tree = '{"version":1,"root":{"kind":"tabs","id":"g","panels":["editor"],"active":"editor"}}'

    expect(() => {
      act(() => {
        result.current.setDockTree(tree)
      })
    }).not.toThrow()

    expect(result.current.state.dockTree).toBe(tree)
    expect(setItemSpy).toHaveBeenCalled()
  })
})
