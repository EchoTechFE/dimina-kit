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
  preloadPath: string
  simulatorUrl: string
  simulatorRef: React.RefObject<HTMLElement | null>
  currentPage: string
  copied: boolean
  onCopyPagePath: () => void
  /**
   * NATIVE-HOST ONLY. When true the simulator is a main-process
   * WebContentsView positioned over this panel region, so we must NOT render
   * the renderer `<webview>` (Electron forbids nesting `<webview>`s, which is
   * the whole reason for the WCV). The bezel chrome stays so the layout column
   * keeps its width; the WCV paints on top.
   *
   * The WCV is positioned to overlap the bezel's inner black screen exactly: a
   * native-host-only effect below measures `innerRef`'s
   * `getBoundingClientRect()` and reports it (rAF-debounced) to main via
   * `setNativeSimulatorBounds`, which feeds `computeNativeSimulatorViewParams`.
   */
  nativeHost: boolean
}

export function SimulatorPanel({
  device,
  zoom,
  onDeviceChange,
  onZoomChange,
  compileStatus,
  preloadPath,
  simulatorUrl,
  simulatorRef,
  currentPage,
  copied,
  onCopyPagePath,
  nativeHost,
}: SimulatorPanelProps) {
  const scale = zoom / 100

  // NATIVE-HOST ONLY refs. `innerRef` is the bezel's black inner-screen div —
  // a NEW ref distinct from `simulatorRef` (which the default path needs for
  // the `<webview>`). `scrollRef` is the `overflow-auto` container we listen to
  // for scroll so the WCV tracks the bezel when the panel scrolls.
  const innerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Measure the inner-screen rect and report it to main (rAF-debounced). Only
  // ever called under native-host; the WCV is overlaid exactly on this rect.
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
    // Default path must be byte-identical: bail before touching anything.
    if (!nativeHost) return
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
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [nativeHost, reportBounds])

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
              {/* Default path: render the simulator as a renderer `<webview>`.
                  Under native-host the simulator is a main-process
                  WebContentsView (mounted via attachNativeSimulator) painted
                  over this region — rendering a `<webview>` here would force a
                  second simulator AND can't host DeviceShell's nested render
                  webviews, so we skip it entirely. */}
              {!nativeHost && preloadPath && simulatorUrl && (
                <webview
                  ref={simulatorRef as React.RefObject<HTMLElement>}
                  src={simulatorUrl}
                  // eslint-disable-next-line react/no-unknown-property
                  partition="persist:simulator"
                  // eslint-disable-next-line react/no-unknown-property
                  allowpopups=""
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: device.width,
                    height: device.height,
                  }}
                />
              )}

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
