import React from 'react'
import { Select } from '@/shared/components/ui/select'
import { cn } from '@/shared/lib/utils'
import { DEVICES, ZOOM_OPTIONS } from '@/shared/constants'

interface Device {
  name: string
  width: number
  height: number
}

interface SimulatorPanelProps {
  simPanelWidth: number
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
}

export function SimulatorPanel({
  simPanelWidth,
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
}: SimulatorPanelProps) {
  const scale = zoom / 100

  return (
    <div
      className="bg-sim-bg flex flex-col overflow-hidden shrink-0"
      style={{
        width: simPanelWidth,
        minWidth: simPanelWidth,
      }}
    >
      <div className="flex-1 overflow-auto flex items-start justify-center p-5">
        {compileStatus.status === 'compiling' && !preloadPath && (
          <div className="flex items-center justify-center min-h-48 w-full text-text-dim text-[13px]">
            正在编译中...
          </div>
        )}
        {compileStatus.status === 'error' && !simulatorUrl && (
          <div className="flex flex-col items-center justify-center min-h-48 w-full text-status-error text-[13px] gap-2 p-4">
            <span>编译失败</span>
            <small className="text-status-error text-[11px]">
              {compileStatus.message}
            </small>
          </div>
        )}
        {(compileStatus.status === 'ready' || simulatorUrl) && (
          <div className="flex flex-col items-center gap-6">
            <div
              className="shrink-0 overflow-visible"
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
                className="bg-black relative overflow-hidden shrink-0"
                style={{
                  borderRadius: 36,
                  width: device.width,
                  height: device.height,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                }}
              >
                {preloadPath && simulatorUrl && (
                  // NOTE: no `preload=` attribute. The simulator preload is
                  // injected exclusively at the session level (see
                  // src/main/windows/main-window/create.ts ::
                  // configureSimulatorSession) and any renderer-supplied
                  // preload that doesn't match the session path is rejected
                  // by will-attach-webview. `preloadPath` here is only used
                  // as a readiness gate so we don't mount the webview before
                  // the main process has resolved the bundle path; it is NOT
                  // plumbed onto the element.
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
              </div>
            </div>

            {compileStatus.status === 'compiling' && simulatorUrl && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-[36px] z-10">
                <div className="text-text-dim text-[13px]">正在编译中...</div>
              </div>
            )}
            {compileStatus.status === 'error' && simulatorUrl && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 rounded-[36px] z-10">
                <div className="text-center p-4">
                  <div className="text-status-error text-[14px] font-medium mb-2">编译失败</div>
                  <div className="text-status-error text-[11px] max-w-[280px] break-words">
                    {compileStatus.message}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
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
