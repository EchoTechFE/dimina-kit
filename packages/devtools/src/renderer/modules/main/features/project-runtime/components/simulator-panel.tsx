import React, { useCallback, useEffect, useRef } from 'react'
import { Select } from '@/shared/components/ui/select'
import { setNativeSimulatorBounds } from '@/shared/api'
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
  const scale = zoom / 100

  // The simulator is a main-process WebContentsView positioned over this panel
  // region (native-host is the sole runtime), so this panel only renders the
  // bezel chrome and reports where the WCV should paint. `innerRef` is the
  // bezel's black inner-screen div the WCV is overlaid on; `scrollRef` is the
  // `overflow-auto` container we listen to for scroll so the WCV tracks the
  // bezel when the panel scrolls.
  const innerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Measure the inner-screen rect and report it to main (rAF-debounced); the
  // WCV is overlaid exactly on this rect via `computeNativeSimulatorViewParams`.
  const rafRef = useRef<number | null>(null)
  const reportBounds = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      const el = innerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      void setNativeSimulatorBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        zoom,
      })
    })
  }, [zoom])

  useEffect(() => {
    const inner = innerRef.current
    const scroller = scrollRef.current
    if (!inner) return

    // Initial measure + re-measure on every geometry change: zoom/device
    // (inner div resize), splitter drag (also resizes the inner div via the
    // column width), panel scroll, and window resize. ResizeObserver covers the
    // size-driven cases; scroll/resize cover position-only changes.
    reportBounds()
    const ro = new ResizeObserver(reportBounds)
    ro.observe(inner)
    scroller?.addEventListener('scroll', reportBounds, { passive: true })
    window.addEventListener('resize', reportBounds)

    return () => {
      ro.disconnect()
      scroller?.removeEventListener('scroll', reportBounds)
      window.removeEventListener('resize', reportBounds)
      // Cancel any in-flight measure so it can't race past the hide report
      // below and re-show the WCV with stale bounds.
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // The panel/cell is being hidden or unmounted (e.g. the toolbar toggled
      // the simulator panel off). The toolbar toggle only mutates renderer
      // layout state, so without an explicit zero-bounds report here the
      // main-process simulator WebContentsView would stay painted over its old
      // region (visual/layering leak). Report a zero-area rect — main treats
      // `{width:0,height:0}` as "hide" and removes the WCV from the contentView.
      void setNativeSimulatorBounds({ x: 0, y: 0, width: 0, height: 0, zoom })
    }
  }, [reportBounds, zoom])

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

      <div ref={scrollRef} className="flex-1 overflow-auto flex items-start justify-center p-5">
        <div className="flex flex-col items-center">
          <div
            className="shrink-0 overflow-visible relative"
            style={{
              borderRadius: 44,
              boxShadow:
                '0 0 0 8px var(--color-phone-shell), 0 0 0 10px var(--color-phone-border), 0 24px 60px var(--color-overlay-heavy)',
              background: 'var(--color-phone-shell)',
              width: Math.round(device.width * scale),
              height: Math.round(device.height * scale),
            }}
          >
            <div
              ref={innerRef}
              className="bg-black relative overflow-hidden shrink-0"
              style={{
                borderRadius: 36,
                width: device.width,
                height: device.height,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            >
              {/* The simulator itself is a main-process WebContentsView
                  (mounted via attachNativeSimulator) painted over this bezel
                  region — it hosts DeviceShell's nested render webviews, so the
                  renderer never renders a `<webview>` here. */}
              {compileStatus.status === 'compiling' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-[36px] z-10">
                  <div className="text-text-dim text-[13px]">正在编译中...</div>
                </div>
              )}
              {compileStatus.status === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/70 rounded-[36px] z-10">
                  <div className="text-center p-4">
                    <div className="text-status-error text-[14px] font-medium mb-2">编译失败</div>
                    <div className="text-status-error text-[11px] max-w-[280px] break-words">
                      {compileStatus.message}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
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
