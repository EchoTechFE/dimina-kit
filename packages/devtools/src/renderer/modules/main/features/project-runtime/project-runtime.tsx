import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { COPY_FEEDBACK_TIMEOUT_MS } from '@/shared/constants'
import {
  getBranding,
  publishSimulatorDevtoolsBounds,
} from '@/shared/api'
import type { Project } from '@/shared/types'
import { useProjectRuntimeController } from './controllers/use-project-runtime-controller'
import { useLayoutStore } from './controllers/use-layout-store'
import { ProjectToolbar } from './components/project-toolbar'
import { SimulatorPanel } from './components/simulator-panel'
import { BottomDebugPanel } from '../bottom-debug-panel/bottom-debug-panel'
import { MonacoEditor } from '../monaco-editor'
import { compileProjectWindowLayout } from './layout/compile'
import { FrameTree } from './layout/frame-tree'
import { useViewAnchor } from '@/lib/view-anchor'
import type { CellId } from './layout/types'

interface ProjectRuntimeProps {
  project: Project
}

/**
 * The project window's main content area.
 *
 * Layout is fully described by `compileProjectWindowLayout(layoutState)` —
 * a pure function from the persisted `LayoutState` (visibility flags +
 * `devtoolsPosition` + `simulatorAlignment`) to a Frame tree + cells
 * registry. `FrameTree` is the recursive renderer; `useViewAnchor`
 * (see `@/lib/view-anchor`) syncs the DevTools overlay's bounds with the
 * main process. Together they
 * replaced the previous ad-hoc `LayoutTree` branching (see the
 * `layout/` directory for the design rationale).
 */
export function ProjectRuntime({ project }: ProjectRuntimeProps) {
  const copyTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  const controller = useProjectRuntimeController({ projectPath: project.path })
  const { session, device, simulator, panelData, rightPane, popover } = controller

  const layout = useLayoutStore()
  const { state: layoutState } = layout

  // Compile layout state into a Frame tree. `compile` is cheap and pure;
  // memoizing on the 5 layout-state fields is enough.
  // `useLayoutStore` returns a fresh `state` object reference on every
  // change, so depending on the object alone re-compiles whenever any field
  // moves — no need to enumerate individual fields (and enumerating them
  // alongside the object trips react-hooks/exhaustive-deps).
  const compiled = useMemo(
    () => compileProjectWindowLayout(layoutState),
    [layoutState],
  )

  // Bounds-sync bindings. Each binding describes a main-process overlay
  // whose rect the renderer must publish whenever:
  //   - layout topology changes (`signature`),
  //   - the active project changes (`projectPath`),
  //   - the cell's presence flips (`cells[id].present`),
  //   - or any `extraDeps` change (e.g. `rightPane.selected` for debug,
  //     because the Console tab's display:none toggle changes the
  //     simulator-devtools placeholder's visible area).
  // The only remaining main-process overlay is the Chromium DevTools view
  // (debug cell). Anchor it to its placeholder DOM via `useViewAnchor`:
  //   - present: the debug cell is in the compiled layout;
  //   - deps: topology signature + project switch + the active debug tab
  //     (Console's display:flex|none changes the placeholder's visible rect
  //     without changing frame topology — the ResizeObserver can't see it).
  // editor is in-renderer Monaco and simulator is a <webview>; neither is a
  // native overlay, so neither needs an anchor.
  const devtoolsAnchorRef = useViewAnchor({
    present: compiled.cells.debug.present,
    publish: publishSimulatorDevtoolsBounds,
    deps: [compiled.signature, project.path, rightPane.rightPane.selected],
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

  // ── Cell nodes — the actual content for each business panel ─────────
  //
  // - `simulator`: SimulatorPanel renders the device-shell + <webview>.
  //   No main-process overlay → no bounds binding.
  //
  // - `editor`: In-renderer Monaco component. It is a normal React child,
  //   not an overlay placeholder, and has no bounds binding.
  //
  // - `debug`: BottomDebugPanel forwards its outer ref to the inner
  //   `[data-area="simulator-devtools"]` placeholder, which is where
  //   the IPC target lives. Hand the debug bounds ref through.
  const cellNodes: Record<CellId, ReactNode> = {
    simulator: (
      <SimulatorPanel
        device={device.device}
        zoom={device.zoom}
        onDeviceChange={device.handleDeviceChange}
        onZoomChange={device.handleZoomChange}
        compileStatus={session.compileStatus}
        preloadPath={session.preloadPath}
        simulatorUrl={simulator.simulatorUrl}
        simulatorRef={simulator.simulatorRef}
        currentPage={simulator.currentPage}
        copied={copied}
        onCopyPagePath={copyPagePath}
      />
    ),
    // In-renderer Monaco editor — replaces the OpenSumi WebContentsView
    // overlay. Plain React component occupying the editor cell; reads/writes
    // the active project's files via the sandboxed `project:fs:*` IPC.
    editor: <MonacoEditor projectPath={project.path} />,
    debug: (
      <BottomDebugPanel
        ref={devtoolsAnchorRef}
        rightPane={rightPane.rightPane}
        onSelectTab={rightPane.selectRightPane}
        wxmlTree={panelData.wxmlTree}
        onRefreshWxml={panelData.refreshWxml}
        onInspectWxml={panelData.inspectWxmlElement}
        onClearWxmlInspection={panelData.clearWxmlElementInspection}
        appData={panelData.appData}
        onRefreshAppData={panelData.refreshAppData}
        onSelectAppDataBridge={panelData.setActiveAppDataBridge}
        storageItems={panelData.storageItems}
        onRefreshStorage={panelData.refreshStorage}
        onSetStorage={panelData.setStorageItem}
        onRemoveStorage={panelData.removeStorageItem}
        onClearStorage={panelData.clearStorage}
        onClearAllStorage={panelData.clearAllStorage}
        getStoragePrefix={panelData.getStoragePrefix}
      />
    ),
  }

  return (
    <div className="flex flex-col h-screen">
      <ProjectToolbar
        compileDropdownRef={popover.compileDropdownRef}
        showCompilePanel={popover.showCompilePanel}
        onToggleCompilePanel={popover.toggleCompilePanel}
        onRelaunch={() => session.relaunch()}
        compileStatus={session.compileStatus}
        layout={layout}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <FrameTree
          layout={compiled}
          cellNodes={cellNodes}
          simPanelWidth={device.simPanelWidth}
          onSimSplitterDrag={device.handleSplitterDrag}
        />
      </div>
    </div>
  )
}
