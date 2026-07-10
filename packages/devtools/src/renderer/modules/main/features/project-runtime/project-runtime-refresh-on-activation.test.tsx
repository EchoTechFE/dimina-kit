/**
 * Devtools "refresh on tab ACTIVATION" under DOM-panel KEEPALIVE.
 *
 * Under DOM-panel keepalive, `<DockView>` keeps inactive DOM bodies MOUNTED and
 * hidden — they never remount on a tab round-trip. A MOUNT-effect refresh
 * (`useEffect(() => {...}, [tabId])`) would therefore fire EXACTLY ONCE for the
 * whole session, leaving the panel stale on every re-activation.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * `DockDebugTab` fires the AppData/Storage per-tab refresh when its panel
 * BECOMES active — including the keepalive case where it was already mounted and
 * is merely RE-activated — NOT only on first mount. Concretely:
 *   - first activation (mount, active) → refresh fires once;
 *   - tab away and back → refresh fires AGAIN on re-activation, WITHOUT the body
 *     having remounted (keepalive: the same DebugTabContent instance persists);
 *   - staying mounted-but-inactive → no refresh.
 * WXML's activation-edge seed lives in the shared ConnectedWxmlPanel (covered
 * by @dimina-kit/wxml-inspect's own suite); the contract at THIS layer is that
 * DockDebugTab feeds it a correct `wxmlActive` on every activation flip while
 * the body stays mounted.
 *
 * We render the REAL `<DockView>` + the REAL ProjectRuntime dock wiring (only the
 * controller + @/shared/api + the leaf DebugTabContent are mocked). The
 * load-bearing assertion is: across a wxml→appdata→wxml tab round-trip, the wxml
 * `DebugTabContent` stays MOUNTED THE WHOLE TIME (keepalive) AND its refresh
 * fired again on re-activation.
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

// ── Controller mock: refresh spies the assertions watch ─────────────────────
const refresh = vi.hoisted(() => ({
  appData: vi.fn(),
  storage: vi.fn(() => Promise.resolve()),
}))
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
      appData: null,
      refreshAppData: refresh.appData,
      setActiveAppDataBridge: vi.fn(),
      storageItems: [],
      refreshStorage: refresh.storage,
      setStorageItem: vi.fn(),
      removeStorageItem: vi.fn(),
      clearStorage: vi.fn(),
      clearAllStorage: vi.fn(),
      getStoragePrefix: vi.fn(),
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
// Every wxmlActive value the wxml tab's DebugTabContent renders with, in
// order — the assertions watch its edges across tab switches.
const wxmlActiveLog = vi.hoisted(() => [] as boolean[])
vi.mock('../bottom-debug-panel/bottom-debug-panel', () => ({
  DebugTabContent: ({ tabId, wxmlActive }: { tabId: string, wxmlActive?: boolean }) => {
    // jsx-free instrumentation via effects.
    return DebugTabStub({ tabId, wxmlActive })
  },
}))

// A tiny instrumented stub component (declared after the mock to keep the mock
// hoist-safe). Records every real mount + unmount of a given tabId, plus the
// wxmlActive stream the wxml tab receives.
function DebugTabStub({ tabId, wxmlActive }: { tabId: string, wxmlActive?: boolean }) {
  if (tabId === 'wxml') wxmlActiveLog.push(!!wxmlActive)
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
  wxmlActiveLog.length = 0
  refresh.appData.mockClear()
  refresh.storage.mockClear()
  dockModelHolder.model = null
})

describe('ProjectRuntime: refresh on tab ACTIVATION under keepalive', () => {
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
  // on every wxmlActive false→true rising edge (guarded in the wxml-inspect
  // suite), and THIS layer must deliver that flip — active → inactive → active
  // again — to the kept-alive (never remounted) DebugTabContent instance.
  it('drives wxmlActive across a tab round-trip while the body stays mounted', () => {
    render(<ProjectRuntime project={PROJECT} />)

    // wxml starts as the active tab.
    expect(wxmlActiveLog.at(-1)).toBe(true)

    activate('appdata') // wxml inactive
    expect(wxmlActiveLog.at(-1)).toBe(false)

    activate('wxml') // re-activated → the rising edge ConnectedWxmlPanel re-seeds on
    expect(wxmlActiveLog.at(-1)).toBe(true)
  })

  // A panel that is kept-alive but INACTIVE must NOT refresh. Switching
  // wxml→appdata fires appdata's refresh (on appdata activation) while the
  // mounted-but-hidden wxml body reads wxmlActive=false — ConnectedWxmlPanel
  // makes no source calls while inactive (guarded in the wxml-inspect suite),
  // so a spurious `true` here is exactly the stale-refresh bug this pins.
  it('does not refresh a mounted-but-inactive tab; only the newly-active one refreshes', () => {
    render(<ProjectRuntime project={PROJECT} />)

    expect(wxmlActiveLog.at(-1)).toBe(true) // initial wxml activation

    activate('appdata')

    // appdata refreshed on its activation.
    expect(refresh.appData.mock.calls.length).toBeGreaterThanOrEqual(1)
    // wxml, now mounted-but-inactive, must read inactive (no re-seed source).
    expect(wxmlActiveLog.at(-1), 'inactive wxml must read wxmlActive=false').toBe(false)
  })
})
