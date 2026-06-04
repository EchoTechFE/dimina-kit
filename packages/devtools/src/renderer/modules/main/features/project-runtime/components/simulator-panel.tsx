import React, { useCallback } from 'react'
import { Select } from '@/shared/components/ui/select'
import { setNativeSimulatorBounds } from '@/shared/api'
import { useViewAnchor, type Bounds } from '@dimina-kit/view-anchor'
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
  // runtime) painted directly over the flex:1 placeholder below. This z2
  // renderer panel draws NO phone/bezel: just the toolbar, an EMPTY placeholder
  // slot, and the page-path bar. The WCV is bound to the placeholder's rect via
  // `useViewAnchor` (the same overlay-binding the DevTools view uses); flex:1
  // sizes ONLY the placeholder region. The WCV is RECTANGULAR — its own
  // web-viewport is the (straight-edged) clip. Inside it, DeviceShell draws the
  // WHOLE phone (rounded corners, notch, nav, viewport, tab/home) at FIXED
  // device-logical size and scrolls it natively when it's larger than the
  // region. zoom is applied as the WCV's zoomFactor (zoom/100), never as a CSS
  // transform here.
  //
  // `present` is constant `true`: FrameTree UNMOUNTS this panel when the
  // simulator cell is hidden, and the hook's unmount teardown publishes one ZERO
  // to collapse the WCV.
  //
  // `publish` carries `zoom` (the `Bounds` rect has no zoom field) so main can
  // `setZoomFactor` the WCV; its identity changes with `zoom`, re-publishing on
  // zoom change. The default `measure` (the placeholder's own
  // getBoundingClientRect) gives the region rect directly — no `measure`
  // override and no `clipToTarget`.
  const publish = useCallback(
    (b: Bounds) => {
      void setNativeSimulatorBounds({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        zoom,
      })
    },
    [zoom],
  )

  const anchorRef = useViewAnchor({
    present: true,
    publish,
    deps: [zoom],
  })

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
