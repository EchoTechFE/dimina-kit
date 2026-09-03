/**
 * Unit tests for `useLayoutStore` (dock-only).
 *
 * The store holds the opaque `dockTree` (serialized DockView layout) PLUS the
 * two toolbar layout-PRESET axes restored on top of the dock model:
 * `simulatorAlignment` ('left'|'right') and `devtoolsPosition`
 * ('inEditor'|'belowSimulator'|'rightOfSimulator'). The legacy per-panel
 * visibility booleans + dockableMode (and the at-least-one-visible sanitize) stay
 * gone — visibility is now the dock tree's panel membership.
 *
 * Public contract under test (see ./use-layout-store.ts):
 * - Records are per project: every project window shares one `file://` origin,
 *   so the layout is keyed by project path and one project never overwrites
 *   another's.
 * - Hydrates `dockTree` from the project's record, from the pre-split shared
 *   record `localStorage['dimina-devtools.layout.v1']` when the project has none
 *   yet, and from DEFAULT_LAYOUT_STATE (`dockTree: null`, alignment `left`,
 *   position `inEditor`) on missing / corrupt / wrong-typed input.
 * - `setDockTree` updates state and persists; setting the same value is a no-op
 *   (identity preserved); a write failure is swallowed.
 *
 * These tests use jsdom's real `window.localStorage`, cleared between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useLayoutStore, DEFAULT_LAYOUT_STATE } from './use-layout-store'

/** The pre-split shared record, now only ever read as a seed. */
const STORAGE_KEY = 'dimina-devtools.layout.v1'

const PROJECT_A = '/Users/dev/工作/alpha project'
const PROJECT_B = '/Users/dev/projects/beta'
const TREE_A = '{"version":1,"root":{"kind":"tabs","id":"a","panels":["editor"],"active":"editor"}}'
const TREE_B = '{"version":1,"root":{"kind":"tabs","id":"b","panels":["simulator"],"active":"simulator"}}'

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
      ;({ result } = renderHook(() => useLayoutStore(PROJECT_A)))
    }).not.toThrow()

    expect(result!.current.state).toEqual(DEFAULT_LAYOUT_STATE)
  })

  // Regression: missing `dockTree` (e.g. a first run, or an older build that did
  // not persist it) must fall back to the default `null`, not leave it undefined.
  it('defaults dockTree to null when the persisted blob omits it', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({}))

    const { result } = renderHook(() => useLayoutStore(PROJECT_A))

    expect(result.current.state).toEqual({ dockTree: null, simulatorAlignment: 'left', devtoolsPosition: 'inEditor' })
  })

  // Regression: a wrong-typed `dockTree` (a number / object instead of the
  // opaque serialized string) must be rejected and replaced with null, never
  // passed through to `buildDockModel` (which would mis-parse it).
  it('rejects a non-string dockTree, replacing it with null', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ dockTree: 123 }))

    const { result } = renderHook(() => useLayoutStore(PROJECT_A))

    expect(result.current.state).toEqual({ dockTree: null, simulatorAlignment: 'left', devtoolsPosition: 'inEditor' })
  })

  // Regression: a valid persisted dockTree string must round-trip verbatim —
  // guards against a hydration bug that would discard the user's saved layout.
  it('hydrates a persisted dockTree string verbatim', () => {
    const stored = { dockTree: '{"version":1,"root":{"kind":"tabs","id":"g","panels":["editor"],"active":"editor"}}' }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

    const { result } = renderHook(() => useLayoutStore(PROJECT_A))

    expect(result.current.state).toEqual({ ...stored, simulatorAlignment: 'left', devtoolsPosition: 'inEditor' })
  })
})

describe('useLayoutStore — setDockTree and persistence', () => {
  // Regression: persisting a dock tree must update state AND write to
  // localStorage so the layout survives a reload. A missing persistence effect
  // would silently drop the saved layout on next mount.
  it('persists a new dockTree and restores it on the next mount', () => {
    const { result, unmount } = renderHook(() => useLayoutStore(PROJECT_A))
    expect(result.current.state.dockTree).toBeNull()

    const tree = '{"version":1,"root":{"kind":"tabs","id":"g","panels":["editor"],"active":"editor"}}'
    act(() => {
      result.current.setDockTree(tree)
    })

    expect(result.current.state.dockTree).toBe(tree)
    expect(window.localStorage.length).toBeGreaterThan(0)

    unmount()
    const { result: reopened } = renderHook(() => useLayoutStore(PROJECT_A))
    expect(reopened.current.state.dockTree).toBe(tree)
  })

  // Regression: setting the SAME serialized value must be a no-op (identity
  // preserved) so the model's persist-subscription re-emitting an unchanged tree
  // does not trigger a redundant re-render / write loop.
  it('returns the same state object when the dockTree value is unchanged', () => {
    const tree = '{"version":1,"root":{"kind":"tabs","id":"g","panels":["editor"],"active":"editor"}}'
    const { result } = renderHook(() => useLayoutStore(PROJECT_A))

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

    const { result } = renderHook(() => useLayoutStore(PROJECT_A))
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

describe('useLayoutStore — per-project isolation', () => {
  // Every project window loads the same file:// origin, so one shared key means
  // two open projects overwrite each other's dock layout. Each project must keep
  // its own record: what one window drags/collapses stays in that window, and
  // reopening a project restores ITS layout, not the last window that saved.
  it('keeps one project layout out of another project, in both directions', () => {
    const { result: a } = renderHook(() => useLayoutStore(PROJECT_A))
    act(() => {
      a.current.setDockTree(TREE_A)
    })

    // A second project window opens while A is still up: it must start from the
    // default layout, not inherit A's.
    const { result: b } = renderHook(() => useLayoutStore(PROJECT_B))
    expect(b.current.state.dockTree).toBeNull()

    act(() => {
      b.current.setDockTree(TREE_B)
      b.current.setSimulatorAlignment('right')
    })

    // Reopening each project restores its own layout, unaffected by the other.
    const { result: reopenedA } = renderHook(() => useLayoutStore(PROJECT_A))
    expect(reopenedA.current.state).toEqual({
      dockTree: TREE_A,
      simulatorAlignment: 'left',
      devtoolsPosition: 'inEditor',
    })

    const { result: reopenedB } = renderHook(() => useLayoutStore(PROJECT_B))
    expect(reopenedB.current.state).toEqual({
      dockTree: TREE_B,
      simulatorAlignment: 'right',
      devtoolsPosition: 'inEditor',
    })
  })

  // Upgrade path: the single pre-split record is the layout the user last chose,
  // so it seeds any project that has no record yet. It must stay readable — a
  // project saving its own layout may not consume or rewrite it, otherwise the
  // first window to move a splitter decides every other project's starting point.
  it('seeds projects from the legacy shared record and leaves that record intact', () => {
    const legacy = JSON.stringify({ dockTree: TREE_A, devtoolsPosition: 'belowSimulator' })
    window.localStorage.setItem(STORAGE_KEY, legacy)

    const { result: a } = renderHook(() => useLayoutStore(PROJECT_A))
    expect(a.current.state).toEqual({
      dockTree: TREE_A,
      simulatorAlignment: 'left',
      devtoolsPosition: 'belowSimulator',
    })

    act(() => {
      a.current.setDockTree(TREE_B)
    })

    const { result: b } = renderHook(() => useLayoutStore(PROJECT_B))
    expect(b.current.state.dockTree).toBe(TREE_A)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(legacy)
  })

  // A window with no project bound yet must not fall back to one shared key —
  // that is the bug in a different disguise. It stays in memory: the layout works
  // for the session and nothing is written or read across windows.
  it('keeps layout in memory only when the window has no project identity', () => {
    const { result } = renderHook(() => useLayoutStore(null))
    act(() => {
      result.current.setDockTree(TREE_A)
    })

    expect(result.current.state.dockTree).toBe(TREE_A)
    expect(window.localStorage.length).toBe(0)

    const { result: other } = renderHook(() => useLayoutStore(''))
    expect(other.current.state.dockTree).toBeNull()
  })

  // One record per project would grow without bound across a machine's lifetime
  // and eventually hit the localStorage quota. Oldest saves are dropped first, so
  // the projects a user actually works on keep their layout.
  it('evicts the least recently saved project once the record cap is exceeded', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `/Users/dev/projects/p${i}`)
    for (const path of paths) {
      const { result, unmount } = renderHook(() => useLayoutStore(path))
      act(() => {
        result.current.setDockTree(`{"id":"${path}"}`)
      })
      unmount()
    }

    const { result: newest } = renderHook(() => useLayoutStore(paths[paths.length - 1]))
    expect(newest.current.state.dockTree).toBe(`{"id":"${paths[paths.length - 1]}"}`)

    const { result: oldest } = renderHook(() => useLayoutStore(paths[0]))
    expect(oldest.current.state.dockTree).toBeNull()

    expect(window.localStorage.length).toBeLessThanOrEqual(32)
  })
})
