/**
 * Unmount placement flush — the hostToolbar residue-on-close-project bug.
 *
 * THE BUG: opening a project mounts a native hostToolbar WCV over
 * ProjectToolbar; closing back to the project list unmounts ProjectRuntime,
 * but nothing tells main's level-triggered reconciler that desired placement
 * is now empty. The last non-empty snapshot this renderer ever published
 * stays frozen in main, so the hostToolbar strip stays attached+visible,
 * overlapping the project-list page underneath.
 *
 * Locked contract: ProjectRuntime's placement publisher is disposed on
 * unmount (`useEffect(() => () => publisher.dispose(), [publisher])`); the
 * new dispose() contract treats "the source of truth just died" as a level —
 * it must synchronously flush one final empty snapshot. This suite pins that
 * flush at the component boundary: after unmount, the LAST call to
 * `publishPlacementSnapshot` must carry `views: []` and the same `generation`
 * this mount used while it was alive.
 *
 * Harness: same `vi.mock('@/shared/api', …)` convention as
 * project-runtime-host-toolbar-replay.test.tsx. `@dimina-kit/view-anchor`'s
 * `useViewAnchor` is mocked to capture the host-toolbar anchor's `publish`
 * callback so the test can drive a real mount-time `publisher.set()` call —
 * giving us a real published generation to compare the post-unmount flush
 * against, instead of asserting against an unobserved value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import type { Project } from '@/shared/types'
import type { Bounds } from '@dimina-kit/view-anchor'
import type { PlacementSnapshot } from '@dimina-kit/electron-deck/layout'

type DevtoolsPlacementSnapshot = PlacementSnapshot<{ zoom?: number }>

// ── @/shared/api mock — publishPlacementSnapshot is the assertion target ───
const api = vi.hoisted(() => {
  const heightListeners: Array<(height: number) => void> = []
  return {
    heightListeners,
    getBranding: vi.fn(() => Promise.resolve({ appName: 'Test App' })),
    publishSimulatorDevtoolsBounds: vi.fn(() => Promise.resolve()),
    publishHostToolbarBounds: vi.fn(() => Promise.resolve()),
    publishPlacementSnapshot: vi.fn((_snapshot: DevtoolsPlacementSnapshot): Promise<void> => Promise.resolve()),
    onHostToolbarHeightChanged: vi.fn((handler: (height: number) => void) => {
      heightListeners.push(handler)
      return () => {
        const i = heightListeners.indexOf(handler)
        if (i >= 0) heightListeners.splice(i, 1)
      }
    }),
    getHostToolbarHeight: vi.fn((): Promise<number | undefined> => Promise.resolve(0)),
  }
})

vi.mock('@/shared/api', () => ({
  getBranding: api.getBranding,
  publishSimulatorDevtoolsBounds: api.publishSimulatorDevtoolsBounds,
  publishHostToolbarBounds: api.publishHostToolbarBounds,
  publishPlacementSnapshot: api.publishPlacementSnapshot,
  onHostToolbarHeightChanged: api.onHostToolbarHeightChanged,
  getHostToolbarHeight: api.getHostToolbarHeight,
}))

// ── Collaborator mocks — same shape as project-runtime-host-toolbar-replay ──
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
      appDataSource: {
        getSnapshot: vi.fn(async () => ({ bridges: [], entries: {} })),
        subscribe: vi.fn(() => () => {}),
        setActive: vi.fn(),
      },
      appDataEnabled: true,
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
    },
    rightPane: { rightPane: { selected: 'console' }, selectRightPane: vi.fn() },
    popover: {
      compileDropdownRef: { current: null },
      showCompilePanel: false,
      toggleCompilePanel: vi.fn(),
    },
  }),
}))

vi.mock('./controllers/use-layout-store', () => ({
  useLayoutStore: () => ({
    state: { dockTree: null },
    setDockTree: vi.fn(),
  }),
}))

vi.mock('./components/project-toolbar', () => ({ ProjectToolbar: () => null }))
vi.mock('./components/simulator-panel', () => ({ SimulatorPanel: () => null }))
vi.mock('../bottom-debug-panel/bottom-debug-panel', () => ({ DebugTabContent: () => null }))
vi.mock('@dimina-kit/electron-deck/dock-react', () => ({ DockView: () => null }))
vi.mock('@dimina-kit/electron-deck/layout', () => ({
  serializeLayout: () => '',
  setConstraint: (t: unknown) => t,
}))
vi.mock('./layout/dock-layout', () => ({
  buildDockModel: () => ({
    get: () => ({ root: { kind: 'tabs', id: 'g', panels: [], active: null } }),
    apply: vi.fn(),
    subscribe: () => () => {},
  }),
  buildDockRegistry: () => ({ get: () => undefined, list: () => [] }),
}))

// ── @dimina-kit/view-anchor mock — captures the hostToolbar anchor's publish
// callback so the test can drive a real `publisher.set()` at will, instead of
// depending on a real ResizeObserver/DOM measurement pipeline.
const viewAnchor = vi.hoisted(() => {
  let latestPublish: ((bounds: Bounds) => void) | undefined
  return {
    setLatestPublish: (fn: (bounds: Bounds) => void) => { latestPublish = fn },
    callLatestPublish: (bounds: Bounds) => {
      if (!latestPublish) throw new Error('useViewAnchor publish callback was never captured')
      latestPublish(bounds)
    },
  }
})

vi.mock('@dimina-kit/view-anchor', () => ({
  useViewAnchor: (opts: { publish: (bounds: Bounds) => void }) => {
    viewAnchor.setLatestPublish(opts.publish)
    return () => {}
  },
  createPlacementAnchor: () => ({ update: vi.fn(), dispose: vi.fn() }),
}))

import { ProjectRuntime } from './project-runtime'

const PROJECT: Project = { name: 'Stub Project', path: '/tmp/stub-project' }

function renderRuntime() {
  return render(<ProjectRuntime project={PROJECT} />)
}

beforeEach(() => {
  api.heightListeners.length = 0
  api.getBranding.mockClear()
  api.onHostToolbarHeightChanged.mockClear()
  api.getHostToolbarHeight.mockClear()
  api.getHostToolbarHeight.mockImplementation(() => Promise.resolve(0))
  api.publishPlacementSnapshot.mockClear()
})

describe('ProjectRuntime: placement publisher flushes an empty snapshot on unmount', () => {
  it('flushes a final empty-views snapshot, at the same generation as the mount, when the component unmounts', async () => {
    const { unmount } = renderRuntime()

    // Drive a real desired-placement publish while mounted (the hostToolbar
    // anchor reporting non-zero bounds), so we have an observed generation to
    // compare the post-unmount flush against.
    act(() => {
      viewAnchor.callLatestPublish({ x: 0, y: 0, width: 375, height: 40 })
    })

    await waitFor(() => expect(api.publishPlacementSnapshot).toHaveBeenCalled())
    const mountCall = api.publishPlacementSnapshot.mock.calls[0]![0]
    expect(mountCall.views.length, 'the mount-time publish must carry a non-empty view table').toBeGreaterThan(0)

    unmount()

    await waitFor(() => {
      const lastCall = api.publishPlacementSnapshot.mock.calls.at(-1)?.[0]
      expect(lastCall, 'unmount must trigger a final publishPlacementSnapshot call').toBeDefined()
      expect(lastCall!.views).toEqual([])
    })

    const lastCall = api.publishPlacementSnapshot.mock.calls.at(-1)![0]
    expect(
      lastCall.generation,
      'the final empty flush must carry the same renderer-lifetime generation as the live mount',
    ).toBe(mountCall.generation)
  })

  it('flushes a final empty-views snapshot on unmount even if the component never published while mounted', async () => {
    // No hostToolbar bounds are ever reported (e.g. the host registered no
    // toolbar and no other view ever went dirty) — but the source of truth
    // still died, so main must still be told desired is now empty.
    const { unmount } = renderRuntime()

    unmount()

    await waitFor(() => {
      expect(
        api.publishPlacementSnapshot,
        'dispose() must flush an empty snapshot even when nothing was ever set()',
      ).toHaveBeenCalled()
    })
    const lastCall = api.publishPlacementSnapshot.mock.calls.at(-1)![0]
    expect(lastCall.views).toEqual([])
  })
})
