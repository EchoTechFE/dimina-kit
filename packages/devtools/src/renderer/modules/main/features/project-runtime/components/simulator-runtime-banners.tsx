import React from 'react'

/**
 * Runtime-lifecycle shape SimulatorPanel and its overlays consume. Declared
 * with a loose `code?: string` (rather than importing
 * `SessionRuntimeStatusPayload` from `@/shared/api`) so any narrower `code`
 * union main settles on later is structurally assignable here — these
 * components only ever DISPLAY `code`, never branch on its exact members.
 */
export interface SimulatorRuntimeStatus {
  appId: string
  phase: 'launching' | 'running' | 'launch-failed' | 'crashed'
  code?: string
  reason?: string
  pageFallback?: { requested: string; resolved: string }
}

interface RuntimeErrorOverlayProps {
  phase: 'launch-failed' | 'crashed'
  code?: string
  reason?: string
  onRelaunch: () => void
}

/**
 * Full-screen error overlay for a runtime-lifecycle terminal failure
 * (launch-failed / crashed) — mirrors the compile-failure overlay's styling.
 * The caller renders this ONLY when the compile-failure overlay is absent: a
 * failed compile has nothing running to report a launch/crash outcome for,
 * so the two are mutually exclusive and compile failure always wins.
 */
export function RuntimeErrorOverlay({ phase, code, reason, onRelaunch }: RuntimeErrorOverlayProps) {
  const title = phase === 'crashed' ? '小程序已崩溃' : '小程序启动失败'
  const detail = reason ?? code ?? '未知原因'
  return (
    <div
      data-testid="sim-runtime-error"
      className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10"
    >
      <div className="text-center p-4">
        <div className="text-status-error text-[14px] font-medium mb-2">{title}</div>
        <div className="text-status-error text-[11px] max-w-[280px] break-words mb-3">
          {detail}
        </div>
        <button
          type="button"
          onClick={onRelaunch}
          className="text-[11px] px-3 py-1 rounded border border-status-error text-status-error hover:bg-status-error/10"
        >
          重新启动
        </button>
      </div>
    </div>
  )
}

interface FallbackBannerProps {
  requested: string
  resolved: string
  onDismiss: () => void
}

/**
 * Non-blocking notice that the requested launch page didn't exist and main
 * fell back to a different one. Dismissible; the caller (SimulatorPanel) resets
 * the dismissal whenever a fresh launch round begins (runtimeStatus goes back
 * to null), so a repeat fallback next round is not silently swallowed.
 */
export function FallbackBanner({ requested, resolved, onDismiss }: FallbackBannerProps) {
  return (
    <div
      data-testid="sim-fallback-banner"
      className="flex items-center gap-2 px-2.5 py-1 bg-status-warn/15 border-b border-status-warn/40 text-[11px] text-status-warn shrink-0"
    >
      <span className="flex-1 min-w-0 truncate">
        启动页 &quot;{requested}&quot; 不存在，已回退到 &quot;{resolved}&quot;
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-status-warn/80 hover:text-status-warn px-1"
        title="关闭"
      >
        ×
      </button>
    </div>
  )
}

/**
 * Persistent warning that the project's file watcher has died — no further
 * save will trigger a recompile. Stays visible for the rest of the session
 * (see use-session's sticky `watcherDead`) and never overlays the device
 * region, matching the "不遮内容" contract.
 */
export function WatcherDeadBar() {
  return (
    <div
      data-testid="sim-watcher-dead-banner"
      className="flex items-center gap-2 px-2.5 py-1 bg-status-error/15 border-b border-status-error/40 text-[11px] text-status-error shrink-0"
    >
      文件监听已停止，后续代码修改将不会自动重新编译
    </div>
  )
}
