/**
 * Devtools "click an already-active tab to close it" contract, scoped to the
 * host wiring in `project-runtime.tsx`.
 *
 * `<DockView>` fires `onActiveTabClick(panelId)` when the user clicks a tab
 * that is ALREADY active (see `dock-view.tsx`'s tab `onClick`: `else
 * ctx.onActiveTabClick?.(panelId)`, only reached when `active` is already
 * true). `<DockView>` itself does not capability-check this path — enforcing
 * a panel's `closable` capability here is entirely the HOST's job, mirroring
 * what the engine's own × affordance does via `closePanelForUser`.
 *
 * `DockableLayout`'s `handleActiveTabClick` (in `./project-runtime.tsx`) wires
 * this callback by calling the raw `closePanel` mutation instead of the
 * capability-aware `closePanelForUser` — so clicking an already-active tab on
 * a `closable:false` debug panel removes it from the tree, bypassing the
 * capability the × button correctly respects.
 *
 * We render the REAL `ProjectRuntime` + REAL dock wiring (only heavy chrome /
 * the controller / `@/shared/api` mocked, matching the harness in
 * `project-runtime-refresh-on-activation.test.tsx`) so this exercises the
 * actual host `handleActiveTabClick` implementation end to end — not a
 * hand-rolled `onActiveTabClick` passed straight to a bare `<DockView>`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { Project } from '@/shared/types'
import {
  createLayoutModel,
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

// ── Controller mock: no refresh assertions needed here, just wiring. ────────
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
      wxmlTree: null,
      refreshWxml: vi.fn(),
      inspectWxmlElement: vi.fn(),
      clearWxmlElementInspection: vi.fn(),
      appData: null,
      refreshAppData: vi.fn(),
      setActiveAppDataBridge: vi.fn(),
      storageItems: [],
      refreshStorage: vi.fn(() => Promise.resolve()),
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

// Heavyweight chrome stubbed away. We keep the REAL DockView + REAL dock
// wiring (DockableLayout's handleActiveTabClick) so the click path is
// exercised end to end.
vi.mock('./components/project-toolbar', () => ({ ProjectToolbar: () => null }))
vi.mock('./components/simulator-panel', () => ({ SimulatorPanel: () => null }))
vi.mock('@dimina-kit/view-anchor', () => ({
  useViewAnchor: () => () => {},
  createPlacementAnchor: () => ({ update: vi.fn(), dispose: vi.fn() }),
}))

// DebugTabContent stub: a plain marker, no need to instrument mounts here.
vi.mock('../bottom-debug-panel/bottom-debug-panel', () => ({
  DebugTabContent: ({ tabId }: { tabId: string }) => <div data-test-debug-tab={tabId} />,
}))

// ── Real DockView, test-controlled model + registry. ────────────────────────
// One tab group with two debug panels: `wxml` is registered `closable: false`
// and is the ACTIVE tab; `appdata` has no `closable` field (default closable).
const dockModelHolder = vi.hoisted(
  () => ({ model: null as ReturnType<typeof createLayoutModel> | null }),
)
function makeTree(active: 'wxml' | 'appdata'): LayoutTree {
  return {
    version: 1,
    root: {
      kind: 'tabs',
      id: 'g-debug',
      panels: ['wxml', 'appdata'],
      active,
    },
  }
}
// Module-level holder so each test can pick which panel starts active before
// `buildDockModel` runs (the mock factory reads it at call time).
const initialActive = vi.hoisted(() => ({ panelId: 'wxml' as 'wxml' | 'appdata' }))
vi.mock('./layout/dock-layout', () => ({
  buildDockModel: () => {
    const m = createLayoutModel(makeTree(initialActive.panelId))
    dockModelHolder.model = m
    return m
  },
  buildDockRegistry: () => ({
    get: (id: string) => {
      if (id === 'wxml') return { kind: 'dom', id, title: 'WXML', closable: false }
      if (id === 'appdata') return { kind: 'dom', id, title: 'AppData' }
      return undefined
    },
    list: () => [],
  }),
}))

import { ProjectRuntime } from './project-runtime'

const PROJECT: Project = { name: 'Stub Project', path: '/tmp/stub-project' }

beforeEach(() => {
  dockModelHolder.model = null
})

describe('ProjectRuntime: clicking an already-active tab respects the closable capability', () => {
  // The active-tab-click path in DockableLayout's handleActiveTabClick calls
  // the raw `closePanel` mutation instead of the capability-aware
  // `closePanelForUser`, so a closable:false panel is removed anyway — the
  // same bypass the × affordance is guarded against by construction.
  it('does not remove an already-active closable:false tab from the dock tree', () => {
    initialActive.panelId = 'wxml'
    const { container } = render(<ProjectRuntime project={PROJECT} />)

    // wxml starts active; clicking its already-active tab routes to
    // onActiveTabClick (DockView only takes that branch when the clicked tab
    // is already the active one).
    const wxmlTab = container.querySelector('[data-deck-tab="wxml"]')
    expect(wxmlTab).not.toBeNull()
    expect(wxmlTab!.getAttribute('data-active')).toBe('true')

    fireEvent.click(wxmlTab!)

    // wxml is closable:false — it must still be present after the click.
    expect(container.querySelector('[data-deck-tab="wxml"]')).not.toBeNull()
    expect(container.querySelector('[data-deck-panel-body="wxml"]')).not.toBeNull()
    const grp = dockModelHolder.model!.get().root as { panels: readonly string[] }
    expect(grp.panels).toContain('wxml')
  })

  // Regression guard: a panel with no `closable` capability (default
  // closable) must still close on an already-active-tab click, exactly as
  // before — the fix for the bug above must not over-correct and make every
  // active-tab click a no-op.
  it('still removes an already-active default-closable tab from the dock tree', () => {
    initialActive.panelId = 'appdata'
    const { container } = render(<ProjectRuntime project={PROJECT} />)

    const appdataTab = container.querySelector('[data-deck-tab="appdata"]')
    expect(appdataTab).not.toBeNull()
    expect(appdataTab!.getAttribute('data-active')).toBe('true')

    fireEvent.click(appdataTab!)

    // appdata has no closable:false capability — the click must still close it.
    expect(container.querySelector('[data-deck-tab="appdata"]')).toBeNull()
    expect(container.querySelector('[data-deck-panel-body="appdata"]')).toBeNull()
    const grp = dockModelHolder.model!.get().root as { panels: readonly string[] }
    expect(grp.panels).not.toContain('appdata')
  })
})
