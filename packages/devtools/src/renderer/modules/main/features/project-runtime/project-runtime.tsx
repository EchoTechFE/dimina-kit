import { useEffect, useRef, useState } from 'react'
import { COPY_FEEDBACK_TIMEOUT_MS } from '@/shared/constants'
import { getBranding } from '@/shared/api'
import type { Project } from '@/shared/types'
import { useProjectRuntimeController } from './controllers/use-project-runtime-controller'
import { ProjectToolbar } from './components/project-toolbar'
import { SimulatorPanel } from './components/simulator-panel'
import { WxmlPanel } from '../right-panel/wxml-panel.js'
import { AppDataPanel } from '../right-panel/appdata-panel.js'
import { StoragePanel } from '../right-panel/storage-panel.js'

interface ProjectRuntimeProps {
  project: Project
}

export function ProjectRuntime({
  project,
}: ProjectRuntimeProps) {
  const copyTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  const controller = useProjectRuntimeController({ projectPath: project.path })
  const { session, device, simulator, panelData, rightPane, popover } = controller

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

  return (
    <div className="flex flex-col h-screen">
      <ProjectToolbar
        compileDropdownRef={popover.compileDropdownRef}
        showCompilePanel={popover.showCompilePanel}
        onToggleCompilePanel={popover.toggleCompilePanel}
        onRelaunch={() => session.relaunch()}
        compileStatus={session.compileStatus}
        rightPane={rightPane.rightPane}
        onToggleRightPaneVisible={rightPane.toggleRightPaneVisible}
        onSelectRightPane={rightPane.selectRightPane}
      />

      <div className="flex flex-1 overflow-hidden">
        <SimulatorPanel
          simPanelWidth={device.simPanelWidth}
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

        <div
          className="w-1 bg-surface-splitter border-l border-r border-border-subtle cursor-col-resize shrink-0 transition-colors hover:bg-accent active:bg-accent"
          onMouseDown={device.handleSplitterDrag}
        />

        <div className="flex flex-1 overflow-hidden">
          {rightPane.rightPane.selected === 'wxml' && (
            <WxmlPanel
              tree={panelData.wxmlTree}
              onRefresh={panelData.refreshWxml}
              onInspectElement={panelData.inspectWxmlElement}
              onClearInspection={panelData.clearWxmlElementInspection}
            />
          )}
          {/* Keepalive: AppDataPanel stays mounted while another right-pane
              tab is selected so the JsonView trees keep their expand/collapse
              state. Other panels still mount/unmount on demand. */}
          <div
            className="flex flex-1 overflow-hidden"
            style={{ display: rightPane.rightPane.selected === 'appdata' ? 'flex' : 'none' }}
          >
            <AppDataPanel
              state={panelData.appData}
              onRefresh={panelData.refreshAppData}
              onSelectBridge={panelData.setActiveAppDataBridge}
            />
          </div>
          {rightPane.rightPane.selected === 'storage' && (
            <StoragePanel items={panelData.storageItems} onRefresh={panelData.refreshStorage} />
          )}
          {rightPane.rightPane.selected === 'simulator' && (
            <div className="flex-1" />
          )}
        </div>
      </div>
    </div>
  )
}
