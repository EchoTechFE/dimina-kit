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
import { useViewAnchor } from '@dimina-kit/view-anchor'
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
 * (see `@dimina-kit/view-anchor`) syncs the DevTools overlay's bounds with the
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

  // Bounds-sync bindings. Both main-process overlays anchored to renderer DOM
  // go through the SAME `useViewAnchor` (see `@dimina-kit/view-anchor`):
  //   - The Chromium DevTools view (debug cell) is anchored HERE, to its
  //     placeholder DOM, because its `present` is "the debug cell is in the
  //     compiled layout" — a decision this component owns. deps = topology
  //     signature + project switch + the active debug tab (Console's
  //     display:flex|none changes the placeholder's visible rect without
  //     changing frame topology — the ResizeObserver can't see it).
  //   - The simulator WebContentsView is anchored INSIDE `SimulatorPanel`, to
  //     its placeholder's own rect (default path — no measure redirect). It's
  //     always present while mounted; FrameTree unmounts the panel to hide it,
  //     and the hook's teardown collapses the WCV.
  // The in-renderer Monaco editor is a plain React child (no native overlay),
  // so it has no anchor.
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
  // - `simulator`: SimulatorPanel renders the device-shell bezel; the
  //   simulator itself is a main-process WebContentsView painted over it.
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
        currentPage={simulator.currentPage}
        copied={copied}
        onCopyPagePath={copyPagePath}
      />
    ),
    // In-renderer Monaco editor — replaces the OpenSumi WebContentsView
    // overlay. Plain React component occupying the editor cell; reads/writes
    // the active project's files via the sandboxed `project:fs:*` IPC.
    // `ready` gates the editor's `project:fs:listFiles` load on the main
    // process having registered the active project. `openProject` clears the
    // main-side path first and sets it only once the compile finishes (the
    // same point it reports `ready`), so loading the file tree before then
    // throws `ENOACTIVE` on every poll. Threading the compile status skips
    // that window instead of retrying through the error.
    editor: (
      <MonacoEditor
        projectPath={project.path}
        ready={session.compileStatus.status === 'ready'}
      />
    ),
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
