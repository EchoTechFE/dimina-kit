import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Select } from '@/shared/components/ui/select'
import { setNativeSimulatorBounds } from '@/shared/api'
import { createPlacementAnchor, type Placement, type PlacementAnchorHandle } from '@dimina-kit/view-anchor'
import { cn } from '@/shared/lib/utils'
import { DEVICES, ZOOM_OPTIONS } from '@/shared/constants'

interface Device {
  name: string
  width: number
  height: number
}

interface SimulatorPanelProps {
  device: Device
  zoom: number
  onDeviceChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  onZoomChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  compileStatus: { status: string; message: string }
  currentPage: string
  copied: boolean
  onCopyPagePath: () => void
}

export function SimulatorPanel({
  device,
  zoom,
  onDeviceChange,
  onZoomChange,
  compileStatus,
  currentPage,
  copied,
  onCopyPagePath,
}: SimulatorPanelProps) {
  // The simulator is a main-process WebContentsView (native-host is the sole
  // runtime) painted directly over the flex:1 placeholder below. This renderer
  // panel draws NO phone/bezel: just the toolbar, an EMPTY placeholder slot, and
  // the page-path bar. Inside the WCV, DeviceShell draws the WHOLE phone (rounded
  // corners, notch, nav, viewport, tab/home) at FIXED device-logical size and
  // scrolls it natively when larger than the region. zoom is applied as the
  // WCV's zoomFactor (zoom/100), never as a CSS transform here.
  //
  // This component is the SOLE simulator-WCV anchor owner. It binds an imperative
  // `createPlacementAnchor` to the device-region div (NOT the engine-agnostic
  // `useViewAnchor`): the simulator dock leaf is pinned to `fixedPx`, so dragging
  // an ADJACENT splitter SHIFTS its x-position WITHOUT resizing it — a
  // ResizeObserver never fires. `followGeometry: true` opens a windowed RAF
  // geometry sentinel that re-publishes the moved rect frame-by-frame. The WCV is
  // a main-process child view. Under DOM-panel keepalive (A3) SimulatorPanel is
  // NOT unmounted when its dock tab deactivates — its slot merely goes
  // `display:none` — so there is no unmount path to publish hidden on a tab
  // switch. To collapse the WCV on deactivation it opts into view-anchor's
  // `guardDisplayNone`: that installs an IntersectionObserver which re-fires on a
  // `display:none` transition (invisible to ResizeObserver) and turns the
  // resulting zero-area measure into a `{ visible:false }` publish, which the
  // `publish` callback below maps to COLLAPSED 0×0 bounds (detaching the WCV).
  // The true unmount path still publishes hidden + disposes as a safety net.
  //
  // Zoom rides in the publish payload (the `Placement` rect has no zoom field) so
  // main can `setZoomFactor` the WCV; it is kept in a ref so the imperative
  // publisher always reads the LIVE value, and a zoom change forces one
  // re-publish.
  const zoomRef = useRef(zoom)
  const anchorHandleRef = useRef<PlacementAnchorHandle | null>(null)

  const publish = useCallback((p: Placement) => {
    if (p.visible) {
      void setNativeSimulatorBounds({
        x: p.bounds.x,
        y: p.bounds.y,
        width: p.bounds.width,
        height: p.bounds.height,
        zoom: zoomRef.current,
      })
    } else {
      // Hidden → collapse the WCV (host treats 0×0 as detach-but-keep-alive).
      void setNativeSimulatorBounds({ x: 0, y: 0, width: 0, height: 0, zoom: zoomRef.current })
    }
  }, [])

  // Ref-callback binding the placement anchor to the device-region div. Mirrors
  // the dock native-slot lifecycle: bind on mount, rebind without a hidden flash
  // on element swap, publish-hidden-then-dispose on unmount.
  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      const existing = anchorHandleRef.current
      if (existing) {
        if (el) {
          existing.dispose()
          anchorHandleRef.current = createPlacementAnchor(el, {
            visible: true,
            followGeometry: true,
            guardDisplayNone: true,
            publish,
          })
        } else {
          existing.update({ visible: false, publish })
          existing.dispose()
          anchorHandleRef.current = null
        }
        return
      }
      if (el) {
        anchorHandleRef.current = createPlacementAnchor(el, {
          visible: true,
          followGeometry: true,
          guardDisplayNone: true,
          publish,
        })
      }
    },
    [publish],
  )

  // Keep the live zoom in the ref BEFORE paint (so a geometry event firing
  // between commit and a passive effect never reads a stale zoom), then force one
  // re-publish so main re-applies `setZoomFactor` on zoom change.
  useLayoutEffect(() => {
    zoomRef.current = zoom
  })
  useLayoutEffect(() => {
    anchorHandleRef.current?.update({ visible: true, publish })
  }, [zoom, publish])

  // Hard-unmount safety: the ref-callback `null` cleanup also disposes, but a
  // teardown that skips the ref cleanup must not leak a live anchor.
  useEffect(() => {
    return () => {
      anchorHandleRef.current?.dispose()
      anchorHandleRef.current = null
    }
  }, [])

  return (
    <div className="bg-sim-bg flex flex-col overflow-hidden h-full w-full">
      <div className="flex items-center gap-2 px-5 py-2 shrink-0 border-b border-border-subtle">
        <Select value={device.name} onChange={onDeviceChange}>
          {DEVICES.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select
          value={zoom}
          onChange={onZoomChange}
          className="max-w-16"
        >
          {ZOOM_OPTIONS.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
        </Select>
      </div>

      <div
        ref={anchorRef}
        className="flex-1 min-h-0 bg-sim-bg relative"
        data-area="native-simulator"
      >
        {/* The simulator itself is a main-process WebContentsView (mounted via
            attachNativeSimulator) painted over this placeholder region — it
            hosts DeviceShell, which draws the whole phone and scrolls it
            natively, so the renderer never renders a `<webview>` here. */}
        {compileStatus.status === 'compiling' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
            <div className="text-text-dim text-[13px]">正在编译中...</div>
          </div>
        )}
        {compileStatus.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
            <div className="text-center p-4">
              <div className="text-status-error text-[14px] font-medium mb-2">编译失败</div>
              <div className="text-status-error text-[11px] max-w-[280px] break-words">
                {compileStatus.message}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center px-2.5 bg-sim-bottom border-t border-border-subtle shrink-0 h-[30px] min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[11px] text-text-dim truncate min-w-0">
            {currentPage || '—'}
          </span>
          {currentPage && (
            <button
              className={cn(
                'shrink-0 flex items-center justify-center w-4 h-4 rounded transition-colors',
                copied ? 'text-accent' : 'text-text-dim hover:text-text'
              )}
              onClick={onCopyPagePath}
              title="复制路径"
            >
              {copied ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline
                    points="1.5,5 4,7.5 8.5,2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect
                    x="1"
                    y="3"
                    width="6"
                    height="6.5"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                  <path
                    d="M3 3V2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H7"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
