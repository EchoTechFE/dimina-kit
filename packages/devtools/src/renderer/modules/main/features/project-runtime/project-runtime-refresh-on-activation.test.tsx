/**
 * Devtools tab-activation flow under DOM-panel KEEPALIVE.
 *
 * Under DOM-panel keepalive, `<DockView>` keeps inactive DOM bodies MOUNTED and
 * hidden — they never remount on a tab round-trip.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * `DockDebugTab` forwards a correct `tabActive` to `DebugTabContent` on every
 * activation flip while the body stays mounted — including the keepalive case
 * where a tab was already mounted and is merely RE-activated. WXML's,
 * Storage's and AppData's activation-edge seeds all live in the shared
 * connected containers (covered by @dimina-kit/inspect's own suite); the
 * contract at THIS layer is purely the `tabActive` delivery, not any refresh
 * bookkeeping of DockDebugTab's own.
 *
 * We render the REAL `<DockView>` + the REAL ProjectRuntime dock wiring (only the
 * controller + @/shared/api + the leaf DebugTabContent are mocked). The
 * load-bearing assertion is: across a wxml→appdata→wxml tab round-trip, the wxml
 * `DebugTabContent` stays MOUNTED THE WHOLE TIME (keepalive) AND its `tabActive`
 * flips correctly on re-activation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useEffect } from 'react'
import type { Project } from '@/shared/types'
import {
  createLayoutModel,
  setActive,
  type LayoutTree,
} from '@dimina-kit/electron-deck/layout'

// ── @/shared/api mock (host-toolbar wiring is irrelevant here) ──────────────
const api = vi.hoisted(() => ({
  getBranding: vi.fn(() => Promise.resolve({ appName: 'Test App' })),
  publishSimulatorDevtoolsBounds: vi.fn(() => Promise.resolve()),
  publishHostToolbarBounds: vi.fn(() => Promise.resolve()),
  // Unmount dispose flushes a final empty snapshot through this; the mocked
  // module must export it or every unmount throws.
  publishPlacementSnapshot: vi.fn(() => Promise.resolve()),
  onHostToolbarHeightChanged: vi.fn((_h: (height: number) => void) => () => {}),
  getHostToolbarHeight: vi.fn((): Promise<number | undefined> => Promise.resolve(0)),
}))
vi.mock('@/shared/api', () => ({
  getBranding: api.getBranding,
  publishSimulatorDevtoolsBounds: api.publishSimulatorDevtoolsBounds,
  publishHostToolbarBounds: api.publishHostToolbarBounds,
  publishPlacementSnapshot: api.publishPlacementSnapshot,
  onHostToolbarHeightChanged: api.onHostToolbarHeightChanged,
  getHostToolbarHeight: api.getHostToolbarHeight,
}))

// ── Controller mock ──────────────────────────────────────────────────────────
vi.mock('./controllers/use-project-runtime-controller', () => ({
  useProjectRuntimeController: () => ({
    session: {
      compileStatus: { status: 'ready', message: '' },
      compileEvents: [],
      compileLogs: [],
      clearCompileEvents: vi.fn(),
      relaunch: vi.fn(),
    },
    device: {
      device: { id: 'stub', name: 'Stub', width: 375, height: 812 },
      zoom: 100,
      handleDeviceChange: vi.fn(),
      handleZoomChange: vi.fn(),
      simPanelWidth: 375,
      handleSplitterDrag: vi.fn(),
    },
    simulator: { currentPage: null },
    panelData: {
      wxmlSource: {
        getSnapshot: vi.fn(async () => null),
        subscribe: vi.fn(() => () => {}),
        setActive: vi.fn(),
        inspect: vi.fn(async () => null),
        clearInspection: vi.fn(),
      },
      wxmlEnabled: true,
      storageSource: {
        getSnapshot: vi.fn(async () => []),
        subscribe: vi.fn(() => () => {}),
        setActive: vi.fn(),
        setItem: vi.fn(async () => ({ ok: true })),
        removeItem: vi.fn(async () => ({ ok: true })),
        clear: vi.fn(async () => ({ ok: true })),
        getPrefix: vi.fn(async () => ''),
      },
      storageEnabled: true,
      appDataSource: {
        getSnapshot: vi.fn(async () => ({ bridges: [], entries: {} })),
        subscribe: vi.fn(() => () => {}),
        setActive: vi.fn(),
      },
      appDataEnabled: true,
    },
    rightPane: { rightPane: { selected: 'wxml' }, selectRightPane: vi.fn() },
    popover: {
      compileDropdownRef: { current: null },
      showCompilePanel: false,
      toggleCompilePanel: vi.fn(),
    },
  }),
}))

vi.mock('./controllers/use-layout-store', () => ({
  useLayoutStore: () => ({ state: { dockTree: null }, setDockTree: vi.fn() }),
}))

// Heavyweight chrome stubbed away. We keep the REAL DockView + REAL dock wiring
// (DockDebugTab) so the integrated activation path is exercised end to end.
vi.mock('./components/project-toolbar', () => ({ ProjectToolbar: () => null }))
vi.mock('./components/simulator-panel', () => ({ SimulatorPanel: () => null }))
vi.mock('@dimina-kit/view-anchor', () => ({
  useViewAnchor: () => () => {},
  createPlacementAnchor: () => ({ update: vi.fn(), dispose: vi.fn() }),
}))

// ── DebugTabContent stub: records mount/unmount per tabId so the keepalive ──
// (no-remount) assertion is observable. The REAL DebugTabContent is heavy and
// not under test here; the refresh wiring lives in DockDebugTab, above it.
const tabMounts = vi.hoisted(() => new Map<string, number>())
const tabUnmounts = vi.hoisted(() => new Map<string, number>())
// Every tabActive value the wxml tab's DebugTabContent renders with, in
// order — the assertions watch its edges across tab switches. (Storage rides
// the SAME `tabActive` prop through the same DockDebugTab path, so the wxml
// tab's stream stands in for every connected-container tab.)
const wxmlTabActiveLog = vi.hoisted(() => [] as boolean[])
vi.mock('../bottom-debug-panel/bottom-debug-panel', () => ({
  DebugTabContent: ({ tabId, tabActive }: { tabId: string, tabActive?: boolean }) => {
    // jsx-free instrumentation via effects.
    return DebugTabStub({ tabId, tabActive })
  },
}))

// A tiny instrumented stub component (declared after the mock to keep the mock
// hoist-safe). Records every real mount + unmount of a given tabId, plus the
// tabActive stream the wxml tab receives.
function DebugTabStub({ tabId, tabActive }: { tabId: string, tabActive?: boolean }) {
  if (tabId === 'wxml') wxmlTabActiveLog.push(!!tabActive)
  useEffect(() => {
    tabMounts.set(tabId, (tabMounts.get(tabId) ?? 0) + 1)
    return () => {
      tabUnmounts.set(tabId, (tabUnmounts.get(tabId) ?? 0) + 1)
    }
  }, [tabId])
  return <div data-test-debug-tab={tabId} />
}

// ── Real DockView, but its MODEL is a test-owned handle so we can drive ──────
// `setActive` from the test. We swap `buildDockModel` for one that returns a
// model whose root is a single tab group of the four DOM debug tabs, and expose
// that model on a module-level holder so the test can apply tab switches.
const dockModelHolder = vi.hoisted(
  () => ({ model: null as ReturnType<typeof createLayoutModel> | null }),
)
// Tree: ONE tab group holding the DOM debug tabs (no native console / no
// simulator), wxml active. Keeps DockView focused on the DOM-keepalive path.
function makeDebugOnlyTree(): LayoutTree {
  return {
    version: 1,
    root: {
      kind: 'tabs',
      id: 'g-debug',
      panels: ['wxml', 'appdata', 'storage', 'compile'],
      active: 'wxml',
    },
  }
}
vi.mock('./layout/dock-layout', () => ({
  buildDockModel: () => {
    const m = createLayoutModel(makeDebugOnlyTree())
    dockModelHolder.model = m
    return m
  },
  buildDockRegistry: () => {
    // Minimal registry: all four debug tabs are DOM panels.
    return {
      get: (id: string) =>
        ['wxml', 'appdata', 'storage', 'compile'].includes(id)
          ? { kind: 'dom', id, title: id }
          : undefined,
      list: () => [],
    }
  },
}))

import { ProjectRuntime } from './project-runtime'

const PROJECT: Project = { name: 'Stub Project', path: '/tmp/stub-project' }

/** Switch the debug group's active tab through the live model. */
function activate(panelId: string): void {
  const m = dockModelHolder.model
  if (!m) throw new Error('dock model not built')
  act(() => {
    m.apply((t) => setActive(t, 'g-debug', panelId))
  })
}

beforeEach(() => {
  tabMounts.clear()
  tabUnmounts.clear()
  wxmlTabActiveLog.length = 0
  dockModelHolder.model = null
})

describe('ProjectRuntime: tab activation under keepalive', () => {
  // The load-bearing keepalive proof at the devtools layer. After a
  // wxml→appdata→wxml round-trip, the wxml DebugTabContent must have stayed
  // MOUNTED the whole time (keepalive: mount count 1, zero unmounts). On HEAD,
  // DockView unmounts the inactive wxml body when appdata activates → wxml
  // remounts on return → mount count 2 / unmount count 1 → FAILS.
  it('a kept-alive debug tab is NOT remounted across a tab round-trip', () => {
    render(<ProjectRuntime project={PROJECT} />)

    // wxml active on first commit.
    expect(tabMounts.get('wxml')).toBe(1)

    // wxml → appdata → wxml.
    activate('appdata')
    activate('wxml')

    // Keepalive: wxml's body was never unmounted, so it never remounted.
    expect(tabUnmounts.get('wxml') ?? 0, 'wxml body must not unmount on switch-away').toBe(0)
    expect(tabMounts.get('wxml'), 'wxml body must not remount on switch-back').toBe(1)
  })

  // The WXML stale-data guard is a two-link chain: ConnectedWxmlPanel re-seeds
  // on every tabActive false→true rising edge (guarded in the shared inspect
  // suite), and THIS layer must deliver that flip — active → inactive → active
  // again — to the kept-alive (never remounted) DebugTabContent instance.
  it('drives tabActive across a tab round-trip while the body stays mounted', () => {
    render(<ProjectRuntime project={PROJECT} />)

    // wxml starts as the active tab.
    expect(wxmlTabActiveLog.at(-1)).toBe(true)

    activate('appdata') // wxml inactive
    expect(wxmlTabActiveLog.at(-1)).toBe(false)

    activate('wxml') // re-activated → the rising edge ConnectedWxmlPanel re-seeds on
    expect(wxmlTabActiveLog.at(-1)).toBe(true)
  })

  // A panel that is kept-alive but INACTIVE must read tabActive=false — a
  // stuck `true` would make ConnectedWxmlPanel keep making source calls while
  // hidden (guarded in the shared inspect suite; this layer only pins the
  // prop it is fed).
  it('a mounted-but-inactive tab reads tabActive=false when a sibling tab activates', () => {
    render(<ProjectRuntime project={PROJECT} />)

    expect(wxmlTabActiveLog.at(-1)).toBe(true) // initial wxml activation

    activate('appdata')

    // wxml, now mounted-but-inactive, must read inactive.
    expect(wxmlTabActiveLog.at(-1), 'inactive wxml must read tabActive=false').toBe(false)
  })
})
