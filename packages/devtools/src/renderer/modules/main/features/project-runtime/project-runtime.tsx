import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { COPY_FEEDBACK_TIMEOUT_MS } from '@/shared/constants'
import {
  getBranding,
  publishSimulatorDevtoolsBounds,
  publishHostToolbarBounds,
  onHostToolbarHeightChanged,
  getHostToolbarHeight,
} from '@/shared/api'
import type { Project } from '@/shared/types'
import { useProjectRuntimeController } from './controllers/use-project-runtime-controller'
import { useLayoutStore } from './controllers/use-layout-store'
import { ProjectToolbar } from './components/project-toolbar'
import { SimulatorPanel } from './components/simulator-panel'
import { EditorPanel } from './components/editor-panel'
import { DebugTabContent } from '../bottom-debug-panel/bottom-debug-panel'
import type { BottomDebugPanelProps, DebugTabContentId } from '../bottom-debug-panel/bottom-debug-panel'
import { useViewAnchor, createPlacementAnchor } from '@dimina-kit/view-anchor'
import type { Placement, PlacementAnchorHandle } from '@dimina-kit/view-anchor'
import { DockView } from '@dimina-kit/electron-deck/dock-react'
import { serializeLayout, setConstraint, closePanel } from '@dimina-kit/electron-deck/layout'
import type { LayoutModel, LayoutNode, PanelRegistry } from '@dimina-kit/electron-deck/layout'
import {
  buildDockModel,
  buildDockRegistry,
} from './layout/dock-layout'

// The seven dock panels after splitting the coarse `debug` into five fine ones.
// `console` is the only native overlay; the rest are DOM panels (simulator +
// editor own their own WCV anchors inside their DOM bodies).
const DOCK_PANEL_IDS = new Set([
  'simulator',
  'editor',
  'wxml',
  'appdata',
  'storage',
  'console',
  'compile',
])

interface ProjectRuntimeProps {
  project: Project
}

/**
 * The project window's main content area.
 *
 * Layout is the layout-engine `<DockView>`, owned entirely by the
 * `<DockableLayout>` child below: simulator (DOM panel owning its WCV anchor) +
 * editor (DOM panel owning the workbench WCV anchor) + the five debug panels
 * (wxml/appdata/storage/console/compile, with console a native overlay). The
 * dock tree is persisted opaquely via the layout store; `dock-layout.ts` seeds
 * the default arrangement on a fresh install. Simulator + editor own their own
 * WCV anchors in `SimulatorPanel`/`EditorPanel`; only the console native-overlay
 * bounds-sync lives inside `DockableLayout` via `createPlacementAnchor`.
 */
export function ProjectRuntime({ project }: ProjectRuntimeProps) {
  const copyTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  const controller = useProjectRuntimeController({ projectPath: project.path })
  const { session, device, simulator, panelData, rightPane, popover } = controller

  const layout = useLayoutStore()
  const { state: layoutState } = layout

  // Dock model + registry are owned HERE (lifted out of DockableLayout) so the
  // toolbar's Panels visibility menu and the DockView render from ONE shared
  // model. ProjectRuntime is keyed on `project.path` at its mount site
  // (main.tsx), so this `useState` initializer rebuilds the model per project —
  // seeding from the persisted tree once, exactly as DockableLayout did before.
  const [dockModel] = useState(() =>
    buildDockModel(layoutState.dockTree ?? null, device.simPanelWidth, DOCK_PANEL_IDS),
  )

  // The 'editor' dock slot is the embedded workbench (a DOM panel owning its
  // WCV anchor); the registry never changes across the component's life.
  const dockRegistry = useMemo(() => buildDockRegistry(), [])

  // Host-controllable toolbar WCV (sits above ProjectToolbar). Dynamic-height
  // loop: the toolbar WCV's own renderer advertises its intrinsic content
  // height (reverse size-advertiser) → main pushes it here as
  // `HostToolbarHeightChanged` → we resize the placeholder div below → the
  // forward anchor re-measures → main re-overlays the WCV. `present` is
  // height > 0 (a height of 0 means the host registered no toolbar, so we emit
  // ZERO and the WCV is collapsed). `deps` carries the height so the anchor
  // re-publishes when the placeholder's rect changes.
  const [hostToolbarHeight, setHostToolbarHeight] = useState(0)
  useEffect(() => {
    // Mount-time REPLAY: the height chain is push-based and the toolbar's
    // size-advertiser deduplicates (a height already reported is never
    // re-sent), so any push that fired before this component mounted is lost —
    // cold start on the project list races it; close-project → reopen hits it
    // deterministically (this component is rebuilt at 0). Main retains the
    // last notified height; subscribe FIRST (a push landing between pull and
    // subscribe would be lost exactly like the original bug), then pull it.
    let pushReceived = false
    const unsubscribe = onHostToolbarHeightChanged((height) => {
      pushReceived = true
      setHostToolbarHeight(height)
    })
    void getHostToolbarHeight().then((height) => {
      // TOCTOU guard: a fresher push won the race while the pull was in
      // flight — applying the stale pull result would snap the strip back.
      if (pushReceived) return
      // The lenient invoke resolves undefined on main-side failure: keep the
      // placeholder collapsed at 0 and let live pushes drive it.
      if (typeof height === 'number') setHostToolbarHeight(height)
    })
    return unsubscribe
  }, [])
  const hostToolbarAnchorRef = useViewAnchor({
    present: hostToolbarHeight > 0,
    publish: publishHostToolbarBounds,
    deps: [hostToolbarHeight],
  })

  useEffect(() => {
    let appName = 'Dimina DevTools'
    document.title = `${project.name} - ${appName}`
    getBranding()
      .then((result) => {
        if (result?.appName) {
          appName = result.appName
          document.title = `${project.name} - ${appName}`
        }
      })
      .catch(() => {})
    return () => {
      document.title = appName
    }
  }, [project.name])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  async function copyPagePath() {
    if (!simulator.currentPage) return
    try {
      await navigator.clipboard.writeText(simulator.currentPage)
      setCopied(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS)
    } catch {
      setCopied(false)
    }
  }

  // Shared debug-panel data + handlers. The dockable `renderDomPanel` forwards
  // them through DebugTabContent so each of the four DOM debug tabs drives the
  // same handlers.
  const debugPanelProps: BottomDebugPanelProps = {
    rightPane: rightPane.rightPane,
    onSelectTab: rightPane.selectRightPane,
    wxmlTree: panelData.wxmlTree,
    onRefreshWxml: panelData.refreshWxml,
    onInspectWxml: panelData.inspectWxmlElement,
    onClearWxmlInspection: panelData.clearWxmlElementInspection,
    appData: panelData.appData,
    onRefreshAppData: panelData.refreshAppData,
    onSelectAppDataBridge: panelData.setActiveAppDataBridge,
    onWxmlActiveChange: panelData.setWxmlActive,
    storageItems: panelData.storageItems,
    onRefreshStorage: panelData.refreshStorage,
    onSetStorage: panelData.setStorageItem,
    onRemoveStorage: panelData.removeStorageItem,
    onClearStorage: panelData.clearStorage,
    onClearAllStorage: panelData.clearAllStorage,
    getStoragePrefix: panelData.getStoragePrefix,
    compileEvents: session.compileEvents,
    compileLogs: session.compileLogs,
    onClearCompileEvents: session.clearCompileEvents,
  }

  // DOM-panel renderer for DockView. `simulator` renders the SimulatorPanel
  // chrome (device/zoom pickers, compile overlays, page-path bar); SimulatorPanel
  // owns the simulator WCV anchor on its device-region div (a bare native slot
  // would render no chrome). `editor` renders EditorPanel, a full-size anchor div
  // owning the workbench WCV placement. The four React debug tabs
  // (wxml/appdata/storage/compile) render through DockDebugTab. The native
  // `console` slot is routed to a NativeSlot by DockView, never here. A plain
  // function (not useCallback): `debugPanelProps` is rebuilt every render with
  // fresh handlers, so memoizing would only pin stale nodes; DockView re-reads it
  // on each render anyway.
  const renderDomPanel = (panelId: string, opts: { active: boolean }): ReactNode => {
    if (panelId === 'simulator') {
      return (
        <SimulatorPanel
          device={device.device}
          zoom={device.zoom}
          onDeviceChange={device.handleDeviceChange}
          onZoomChange={device.handleZoomChange}
          compileStatus={session.compileStatus}
          currentPage={simulator.currentPage}
          copied={copied}
          onCopyPagePath={copyPagePath}
        />
      )
    }
    if (panelId === 'editor') {
      return <EditorPanel />
    }
    if (
      panelId === 'wxml' ||
      panelId === 'appdata' ||
      panelId === 'storage' ||
      panelId === 'compile'
    ) {
      // DOCK path (keepalive): `renderActiveBody` keeps ALL DOM debug tabs
      // mounted, so the `DockDebugTab` is NOT remounted on a tab switch. It fires
      // the per-tab refresh off the `active` false→true edge (M3) — the dock tab
      // strip drives activation through the model and never calls a
      // `handleSelectTab`.
      return <DockDebugTab tabId={panelId} active={opts.active} panelProps={debugPanelProps} />
    }
    return null
  }

  return (
    <div className="flex flex-col h-screen">
      {/*
        Placeholder reserving space for the host-controllable toolbar WCV. Its
        bounds are published to main via the forward anchor; its height is
        driven by the WCV's advertised intrinsic height (see hostToolbarHeight
        above). The flex-col root pushes everything below down automatically —
        no offset math anywhere.
      */}
      <div
        ref={hostToolbarAnchorRef}
        style={{ height: hostToolbarHeight }}
        className="shrink-0 w-full"
        data-area="host-toolbar"
      />
      <ProjectToolbar
        compileDropdownRef={popover.compileDropdownRef}
        showCompilePanel={popover.showCompilePanel}
        onToggleCompilePanel={popover.toggleCompilePanel}
        onRelaunch={() => session.relaunch()}
        compileStatus={session.compileStatus}
        dockModel={dockModel}
        dockRegistry={dockRegistry}
        layout={layout}
        simPanelWidth={device.simPanelWidth}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        {/*
          The dock layout is the SOLE layout. DockableLayout owns all dock state
          and builds its model synchronously on mount, so DockView renders on the
          first commit. Keying on `project.path` remounts it on a project switch
          so the new project's persisted tree seeds a fresh model.
        */}
        <DockableLayout
          dockModel={dockModel}
          dockRegistry={dockRegistry}
          simPanelWidth={device.simPanelWidth}
          renderDomPanel={renderDomPanel}
          onPersistTree={layout.setDockTree}
          persistedTree={layoutState.dockTree ?? null}
        />
      </div>
    </div>
  )
}

interface DockableLayoutProps {
  /** The shared dock model, built + owned by ProjectRuntime. */
  dockModel: LayoutModel
  /** The shared panel registry, built + owned by ProjectRuntime. */
  dockRegistry: PanelRegistry
  /**
   * Current device pixel width. Re-pins the simulator's fixed-px leaf live on a
   * device change (the picker changes width without a remount — without this the
   * simulator leaf would keep the old device width).
   */
  simPanelWidth: number
  /** DOM-panel renderer for simulator/editor/debug bodies (console is the only
   * native panel → routed to a NativeSlot, never through this). */
  renderDomPanel: (panelId: string, opts: { active: boolean }) => ReactNode
  /** Persist DockView's in-session layout mutations (opaque serialized tree). */
  onPersistTree: (serialized: string) => void
  /**
   * The RAW persisted tree string the model was seeded from (or null on a fresh
   * install). Used ONLY for the mount-time force-persist: `buildDockModel` heals
   * a flexible child collapsed to a ~0 weight, but that healing lives in the
   * model's INITIAL state and fires no `subscribe` emission — so without a
   * compare-on-mount the stale 0-weight string would survive in localStorage and
   * re-collapse the panel next launch. When the model's current serialization
   * differs from this, we persist the healed value once.
   */
  persistedTree: string | null
}

/** Does `simulator` appear anywhere in this node's subtree? */
function subtreeHasSimulator(node: LayoutNode): boolean {
  if (node.kind === 'tabs') return node.panels.includes('simulator')
  return node.children.some(subtreeHasSimulator)
}

/** The min-px floor of the constraint at a located split/child site, or null. */
function constraintMinPxAt(
  root: LayoutNode,
  site: { splitId: string; childIndex: number },
): number | null {
  function find(node: LayoutNode): number | null {
    if (node.kind === 'tabs') return null
    if (node.id === site.splitId) {
      const c = node.constraints?.[site.childIndex] ?? null
      return c?.minPx ?? null
    }
    for (const child of node.children) {
      const hit = find(child)
      if (hit !== null) return hit
    }
    return null
  }
  return find(root)
}

/**
 * Locate the fixed-px constraint that pins the simulator's width: the split id +
 * child index of the FIRST constrained child whose subtree contains the
 * `simulator` panel. Matching the constrained child by "contains simulator"
 * (not "is the simulator tab group") keeps the re-pin correct after an
 * edge-drop onto the simulator turns its leading group into a nested split while
 * the constraint stays on that subtree. Returns `null` only when the
 * simulator is not inside any fixed-px region (e.g. re-docked into a flexible
 * group) — the caller then skips the live re-pin rather than guessing. Walks the
 * tree (does NOT assume `root.children[0]`).
 */
function findSimulatorConstraintSite(
  node: LayoutNode,
): { splitId: string; childIndex: number } | null {
  if (node.kind === 'tabs') return null
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (
      (node.constraints?.[i] ?? null) !== null &&
      subtreeHasSimulator(child)
    ) {
      return { splitId: node.id, childIndex: i }
    }
    const hit = findSimulatorConstraintSite(child)
    if (hit) return hit
  }
  return null
}

/**
 * The dock layout — the SOLE project-window layout.
 *
 * The model is built SYNCHRONOUSLY in `useState`'s initializer so `<DockView>`
 * renders on the very first commit. The only native overlay this component owns
 * is the CONSOLE; the simulator and editor WCV anchors live in their own DOM
 * panels (`SimulatorPanel`/`EditorPanel`). The simulator's device-width pin is
 * kept live via `setConstraint` on a device change.
 */
/**
 * Dock-mode wrapper for a DOM debug tab. Under DOM-panel KEEPALIVE every debug
 * tab body stays MOUNTED (inactive ones hidden), so this component is NOT
 * remounted on a tab switch — its `active` prop flips instead. It fires the
 * per-tab data refresh off the `active` false→true edge (mirroring
 * `BottomDebugPanel.handleSelectTab`, M3): the dock tab strip drives activation
 * through the layout model and never calls `handleSelectTab`, so without this the
 * WXML/AppData/Storage panels would show stale data when re-activated.
 * `'compile'` is push-fed (projectStatus + compileLog), so it needs no refresh.
 * Refresh handlers are read through a ref so the activation effect depends only
 * on `tabId`/`active` (the props object is rebuilt every render and would
 * otherwise re-fire the refresh on every render).
 */
function DockDebugTab(
  { tabId, active, panelProps }: { tabId: DebugTabContentId; active: boolean; panelProps: BottomDebugPanelProps },
): ReactNode {
  // Keep the latest refresh handlers in a ref (updated in an effect, not during
  // render) so the activation effect can depend only on `tabId`/`active`. This
  // effect has no deps → it runs on every commit and, by declaration order,
  // BEFORE the activation effect below, so the ref is always current when a
  // refresh fires.
  const propsRef = useRef(panelProps)
  useEffect(() => {
    propsRef.current = panelProps
  })
  // Refresh on the false→true activation edge (NOT every render): a kept-alive
  // body is never remounted, so the refresh must be driven by becoming active.
  // The initial commit (active=true) counts as the first edge (prev defaults to
  // false). A mounted-but-inactive tab (active=false) never refreshes.
  const prevActive = useRef(false)
  useEffect(() => {
    const becameActive = active && !prevActive.current
    prevActive.current = active
    if (!becameActive) return
    const p = propsRef.current
    if (tabId === 'wxml') p.onRefreshWxml()
    else if (tabId === 'appdata') p.onRefreshAppData()
    else if (tabId === 'storage') void p.onRefreshStorage()
  }, [tabId, active])
  // WXML visibility gate: main only runs the render-guest DOM observer + live
  // tree pushes while the WXML panel is visible, so signal BOTH edges (not just
  // false→true) and stop observing when the panel unmounts.
  useEffect(() => {
    if (tabId !== 'wxml') return
    propsRef.current.onWxmlActiveChange?.(active)
    return () => { propsRef.current.onWxmlActiveChange?.(false) }
  }, [tabId, active])
  return <DebugTabContent tabId={tabId} {...panelProps} />
}

function DockableLayout(props: DockableLayoutProps): ReactNode {
  const { dockModel, dockRegistry, simPanelWidth, renderDomPanel, onPersistTree, persistedTree } = props

  // Native CONSOLE overlay (the simulator's Chromium DevTools WebContentsView).
  // Its bounds ride a SEPARATE channel (`publishSimulatorDevtoolsBounds`) from
  // the simulator device WCV (which `SimulatorPanel` owns). `guardDisplayNone`
  // is on: when the console tab is inactive the slot is display:none, which must
  // DETACH the overlay (publish hidden) rather than overlay a 0×0 rect over live
  // content. Console is the ONLY native dock panel — simulator and editor are DOM
  // panels owning their own WCV anchors (`SimulatorPanel`/`EditorPanel`), so
  // `bindNativeSlot` only fires for console and a simulator/editor branch here
  // would be dead code.
  const consoleAnchorRef = useRef<PlacementAnchorHandle | null>(null)
  const publishConsole = useCallback((p: Placement) => {
    if (p.visible) {
      void publishSimulatorDevtoolsBounds({
        x: p.bounds.x,
        y: p.bounds.y,
        width: p.bounds.width,
        height: p.bounds.height,
      })
    } else {
      void publishSimulatorDevtoolsBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [])

  // Bind/rebind/release the console native-overlay anchor for `el`. The overlay
  // needs display:none detach (an inactive tab releases the WCV), `followScroll`
  // (track ancestor scroll), AND `followGeometry`: a drag-re-dock can MOVE the
  // slot without resizing it, and a ResizeObserver never fires on a pure
  // translate, so the geometry sentinel re-publishes the rect.
  const bindOverlayAnchor = useCallback(
    (
      ref: MutableRefObject<PlacementAnchorHandle | null>,
      el: HTMLElement | null,
      publish: (p: Placement) => void,
    ) => {
      if (ref.current) {
        if (el) {
          ref.current.dispose()
          ref.current = createPlacementAnchor(el, {
            visible: true,
            guardDisplayNone: true,
            followScroll: true,
            followGeometry: true,
            publish,
          })
        } else {
          ref.current.update({ visible: false, publish })
          ref.current.dispose()
          ref.current = null
        }
        return
      }
      if (el) {
        ref.current = createPlacementAnchor(el, {
          visible: true,
          guardDisplayNone: true,
          followScroll: true,
          followGeometry: true,
          publish,
        })
      }
    },
    [],
  )

  const bindNativeSlot = useCallback(
    (panelId: string, el: HTMLElement | null) => {
      if (panelId === 'console') {
        bindOverlayAnchor(consoleAnchorRef, el, publishConsole)
      }
    },
    [bindOverlayAnchor, publishConsole],
  )

  // Live device-width re-pin: the simulator column's `minPx` FLOOR must follow
  // the device width. On a device change the picker updates `simPanelWidth`
  // without a remount, so re-pin the simulator's `minPx` constraint in the model.
  // Skip when the floor already equals `simPanelWidth` (no redundant emission, N1)
  // or when the simulator isn't min-px floored (a re-dock moved it out).
  useEffect(() => {
    const root = dockModel.get().root
    const site = findSimulatorConstraintSite(root)
    if (!site) return
    if (constraintMinPxAt(root, site) === simPanelWidth) return
    dockModel.apply((t) => {
      const cur = findSimulatorConstraintSite(t.root)
      if (!cur) return t
      if (constraintMinPxAt(t.root, cur) === simPanelWidth) return t
      return setConstraint(t, cur.splitId, cur.childIndex, { minPx: simPanelWidth })
    })
  }, [dockModel, simPanelWidth])

  // Dispose the console anchor on unmount (the slot's `null` cleanup also
  // disposes, but a hard unmount of the whole component must not leak it).
  useEffect(() => {
    return () => {
      consoleAnchorRef.current?.dispose()
      consoleAnchorRef.current = null
    }
  }, [])

  // Persist DockView's in-session layout mutations back to the store.
  useEffect(() => {
    const unsub = dockModel.subscribe((snap) => {
      onPersistTree(serializeLayout(snap.tree))
    })
    return unsub
  }, [dockModel, onPersistTree])

  // Force-persist a HEALED tree on mount. `buildDockModel` runs
  // `sanitizeFlexibleWeights` on the restored tree (lifting a flexible child
  // collapsed to a ~0 weight), but that healing is the model's INITIAL state and
  // fires no `subscribe` emission — so the stale 0-weight string would otherwise
  // survive in localStorage and re-collapse the panel on the next launch. If the
  // model's current serialization differs from the raw persisted string, write
  // the healed value back ONCE (mount-only: deps are empty so a later in-session
  // mutation goes through the subscribe path above, not here).
  useEffect(() => {
    const current = serializeLayout(dockModel.get())
    if (current !== persistedTree) onPersistTree(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clicking an already-active tab closes that panel (removes it from the
  // tree). Structural panels (simulator/editor) are protected. Closed panels
  // can be reopened from the toolbar Panels menu.
  const handleActiveTabClick = useCallback(
    (panelId: string) => {
      if (panelId === 'simulator' || panelId === 'editor') return
      dockModel.apply((t) => closePanel(t, panelId))
    },
    [dockModel],
  )

  return (
    <DockView
      model={dockModel}
      registry={dockRegistry}
      renderDomPanel={renderDomPanel}
      bindNativeSlot={bindNativeSlot}
      onActiveTabClick={handleActiveTabClick}
    />
  )
}
