/**
 * Host-toolbar height replay — renderer mount half (ProjectRuntime).
 *
 * THE BUG: ProjectRuntime owns the toolbar placeholder height as `useState(0)`
 * and only subscribes
 * `onHostToolbarHeightChanged` in a mount `useEffect`. The height chain is
 * push-only and the toolbar WCV's size-advertiser DEDUPLICATES (a height
 * already reported is never re-sent), so any push that fired before this
 * component mounted is permanently lost:
 *  - cold start landing on the project list = race (the toolbar content loads
 *    and advertises while no project view exists);
 *  - close project → reopen = 100% deterministic (this component is rebuilt
 *    at 0; nothing ever pushes again).
 *
 * Locked contract (renderer half of the fix — main retains the value, pinned
 * in host-toolbar-height-retention.test.ts; the renderer pulls it via the new
 * `getHostToolbarHeight()` view-api wrapper, pinned in
 * view-api-get-host-toolbar-height.test.ts):
 *  - on mount, ProjectRuntime SUBSCRIBES first, then PULLS the retained
 *    height and applies it to the `[data-area="host-toolbar"]` placeholder;
 *  - a push that lands while the pull is still in flight WINS — the stale
 *    pull result must not overwrite it (TOCTOU guard);
 *  - a pull that resolves `undefined` (the lenient ipc-transport invoke
 *    swallows main-side errors into undefined) keeps the placeholder at 0 and
 *    throws nowhere.
 *
 * Harness: same `vi.mock('@/shared/api', …)` convention as the
 * use-session-* suites; all heavyweight children / controller hooks are
 * mocked away so the suite exercises exactly the placeholder-height wiring.
 * `getHostToolbarHeight` is provided BY THE MOCK; the module is fully replaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import type { Project } from '@/shared/types'

// ── @/shared/api mock — push listeners captured, pull controllable ─────────
const api = vi.hoisted(() => {
  const heightListeners: Array<(height: number) => void> = []
  return {
    heightListeners,
    getBranding: vi.fn(() => Promise.resolve({ appName: 'Test App' })),
    publishSimulatorDevtoolsBounds: vi.fn(() => Promise.resolve()),
    publishHostToolbarBounds: vi.fn(() => Promise.resolve()),
    onHostToolbarHeightChanged: vi.fn((handler: (height: number) => void) => {
      heightListeners.push(handler)
      return () => {
        const i = heightListeners.indexOf(handler)
        if (i >= 0) heightListeners.splice(i, 1)
      }
    }),
    // FUTURE view-api export (the replay pull). The mock provides it so the
    // implemented component finds it here; today's component ignoring it is
    // exactly the red state.
    getHostToolbarHeight: vi.fn((): Promise<number | undefined> => Promise.resolve(0)),
  }
})

vi.mock('@/shared/api', () => ({
  getBranding: api.getBranding,
  publishSimulatorDevtoolsBounds: api.publishSimulatorDevtoolsBounds,
  publishHostToolbarBounds: api.publishHostToolbarBounds,
  onHostToolbarHeightChanged: api.onHostToolbarHeightChanged,
  getHostToolbarHeight: api.getHostToolbarHeight,
}))

// ── Collaborator mocks — this suite tests ONLY the placeholder wiring ───────
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
      refreshStorage: vi.fn(),
      setStorageItem: vi.fn(),
      removeStorageItem: vi.fn(),
      clearStorage: vi.fn(),
      clearAllStorage: vi.fn(),
      getStoragePrefix: vi.fn(),
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

// The dock layout is the sole content; stub it out so this suite exercises only
// the host-toolbar placeholder-height wiring (the dock engine is covered by its
// own suites). Stubbing the component avoids pulling in DockView / the layout
// engine here.
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
// useViewAnchor returns a callback ref; createPlacementAnchor is unused here
// (simulator-panel is stubbed). Bounds publication is not under test.
vi.mock('@dimina-kit/view-anchor', () => ({
  useViewAnchor: () => () => {},
  createPlacementAnchor: () => ({ update: vi.fn(), dispose: vi.fn() }),
}))

import { ProjectRuntime } from './project-runtime'

const PROJECT: Project = { name: 'Stub Project', path: '/tmp/stub-project' }

function renderRuntime() {
  return render(<ProjectRuntime project={PROJECT} />)
}

function placeholderHeight(container: HTMLElement): string {
  const el = container.querySelector<HTMLElement>('[data-area="host-toolbar"]')
  expect(el, 'the [data-area="host-toolbar"] placeholder must render').not.toBeNull()
  return el!.style.height
}

/** Push a height the way main's HostToolbarHeightChanged notify would. */
function pushHeight(height: number): void {
  for (const listener of [...api.heightListeners]) listener(height)
}

beforeEach(() => {
  api.heightListeners.length = 0
  api.getBranding.mockClear()
  api.onHostToolbarHeightChanged.mockClear()
  api.getHostToolbarHeight.mockClear()
  api.getHostToolbarHeight.mockImplementation(() => Promise.resolve(0))
})

describe('ProjectRuntime: host-toolbar height replay on mount', () => {
  it('regression pin (GREEN today): a live push after mount drives the placeholder', async () => {
    // Today's working path — the dynamic-height loop while the component is
    // mounted. Pins that the replay fix does not break it, and self-validates
    // this harness (the placeholder renders and reacts inside these mocks, so
    // the red tests below fail on the missing replay, not on a broken rig).
    const { container } = renderRuntime()

    expect(placeholderHeight(container)).toBe('0px')
    await waitFor(() => expect(api.onHostToolbarHeightChanged).toHaveBeenCalled())

    act(() => pushHeight(64))
    await waitFor(() => expect(placeholderHeight(container)).toBe('64px'))
  })

  it('pulls the retained height on mount and applies it to the placeholder', async () => {
    // THE deterministic repro, unit-sized: main retained 64 from a pre-mount
    // advertise (close→reopen / cold start); a freshly-mounted ProjectRuntime
    // must recover it by pulling. Today nothing pulls → stuck at 0px.
    api.getHostToolbarHeight.mockImplementation(() => Promise.resolve(64))

    const { container } = renderRuntime()

    await waitFor(() => {
      expect(
        api.getHostToolbarHeight,
        'ProjectRuntime must pull the retained toolbar height on mount (replay) — the advertiser deduplicates and will never re-push it',
      ).toHaveBeenCalled()
    })
    await waitFor(() => expect(placeholderHeight(container)).toBe('64px'))
  })

  it('subscribes BEFORE pulling (no notify may slip between pull and subscribe)', async () => {
    // Pull-then-subscribe has a hole: a push landing between the two is lost
    // exactly like today's bug. Order is part of the contract.
    const { unmount } = renderRuntime()

    await waitFor(() => expect(api.getHostToolbarHeight).toHaveBeenCalled())

    const subscribeOrder = api.onHostToolbarHeightChanged.mock.invocationCallOrder[0]
    const pullOrder = api.getHostToolbarHeight.mock.invocationCallOrder[0]
    expect(subscribeOrder, 'mount must subscribe onHostToolbarHeightChanged').toBeDefined()
    expect(pullOrder, 'mount must pull getHostToolbarHeight').toBeDefined()
    expect(
      subscribeOrder!,
      'the subscription must be registered before the pull is issued',
    ).toBeLessThan(pullOrder!)

    unmount()
  })

  it('a push that lands while the pull is in flight wins over the stale pull result', async () => {
    // TOCTOU guard: pull resolves with the value retained at request time; if
    // a FRESHER push arrived meanwhile, applying the pull result would snap
    // the strip back to a stale height.
    let resolvePull: ((height: number) => void) | undefined
    api.getHostToolbarHeight.mockImplementation(
      () => new Promise<number | undefined>((resolve) => { resolvePull = resolve }),
    )

    const { container } = renderRuntime()

    await waitFor(() => expect(api.getHostToolbarHeight).toHaveBeenCalled())
    expect(resolvePull).toBeDefined()

    // Fresh push arrives first…
    act(() => pushHeight(72))
    await waitFor(() => expect(placeholderHeight(container)).toBe('72px'))

    // …then the stale pull resolves. It must NOT clobber the fresher 72.
    await act(async () => {
      resolvePull!(64)
      await Promise.resolve()
    })
    expect(placeholderHeight(container)).toBe('72px')
  })

  it('a pull that resolves undefined (swallowed ipc error) keeps 0 and pushes still work', async () => {
    // The lenient ipc-transport invoke resolves `undefined` on main-side
    // failure. The placeholder must stay collapsed (0px), nothing may throw,
    // and the live push path must keep functioning afterwards.
    api.getHostToolbarHeight.mockImplementation(() => Promise.resolve(undefined))

    const { container } = renderRuntime()

    await waitFor(() => expect(api.getHostToolbarHeight).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(placeholderHeight(container)).toBe('0px')

    act(() => pushHeight(48))
    await waitFor(() => expect(placeholderHeight(container)).toBe('48px'))
  })
})
