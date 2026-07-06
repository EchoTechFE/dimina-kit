/**
 * Wires devkit's warm-standby compile worker into the devtools runtime.
 *
 * While no project is open, devkit keeps one project-agnostic compile worker
 * forked + prewarmed; every openProject adopts it so the first compile skips
 * fork + compiler import (~1.6s). This module owns exactly the glue devtools
 * needs on top: turn the accelerator on at boot, mirror its lifecycle events
 * onto the diagnostics bus (a user-machine bug report then carries the whole
 * standby story), and shut it down with the context.
 *
 * Failure-transparent by design: if devkit is missing or predates the standby
 * API, the accelerator silently stays off — compilation itself is untouched
 * (the adapter falls back to devkit's normal cold-fork path, or the host runs
 * its own adapter entirely).
 */
import type { DiagnosticsBus, DiagnosticSeverity } from './diagnostics/index.js'

interface StandbyEventLike {
  type: string
  pid?: number
  reason?: string
}

interface StandbyManagerLike {
  dispose: () => Promise<void>
}

interface DevkitStandbyModule {
  enableCompileWorkerStandby?: (opts?: {
    onEvent?: (ev: StandbyEventLike) => void
  }) => StandbyManagerLike
}

export interface CompileStandbyDeps {
  /** Test hook: replaces the dynamic import('@dimina-kit/devkit'). */
  loadDevkit?: () => Promise<unknown>
}

const EVENT_SEVERITY: Record<string, DiagnosticSeverity> = {
  'spawned': 'info',
  'prewarmed': 'info',
  'adopted': 'info',
  'died': 'warn',
  'health-check-failed': 'warn',
  'degraded': 'error',
}

export function setupCompileWorkerStandby(
  ctx: { diagnostics?: DiagnosticsBus },
  deps: CompileStandbyDeps = {},
): { dispose: () => Promise<void> } {
  const loadDevkit = deps.loadDevkit ?? (() => import('@dimina-kit/devkit'))
  let manager: StandbyManagerLike | null = null
  let disposed = false

  const forward = (ev: StandbyEventLike): void => {
    try {
      const detail = [
        `compile standby ${ev.type}`,
        typeof ev.pid === 'number' ? `pid=${ev.pid}` : null,
        ev.reason ? `— ${ev.reason}` : null,
      ].filter(Boolean).join(' ')
      ctx.diagnostics?.report({
        severity: EVENT_SEVERITY[ev.type] ?? 'info',
        code: 'compile-standby',
        message: detail,
      })
    } catch {
      // telemetry must never break the standby
    }
  }

  void (async () => {
    let enable: DevkitStandbyModule['enableCompileWorkerStandby']
    try {
      const devkit = await loadDevkit() as DevkitStandbyModule
      enable = devkit.enableCompileWorkerStandby
    } catch {
      // devkit unavailable — the accelerator quietly stays off.
      return
    }
    if (typeof enable !== 'function') return
    manager = enable({ onEvent: forward })
    // A teardown that raced the async load wins: the manager is disposed the
    // moment it exists, so a quitting app can never leak a fresh spare.
    if (disposed) void manager.dispose()
  })()

  return {
    dispose: async () => {
      if (disposed) return
      disposed = true
      await manager?.dispose()
    },
  }
}
