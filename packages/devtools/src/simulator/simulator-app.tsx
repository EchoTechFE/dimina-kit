import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { directRequest } from './direct-request'
import { simulatorApis } from './simulator-api'
import { registerCustomApis } from './custom-api-boot'
import { resolveCustomApisBridge } from './resolve-custom-apis-bridge'
import { parseLocationRoute, parseRoute } from '../shared/simulator-route'
import type { PageSpec } from '../shared/simulator-route'
import { SIMULATOR_EVENTS } from '../shared/bridge-channels'
import type { RelaunchPayload } from '../shared/bridge-channels'
import type { SimulatorMiniApp } from './simulator-mini-app'

// The native-host render tree (DeviceShell + device-shell.css) is code-split so
// the simulator entry bundle stays small; the chunk is fetched lazily on boot.
// (SimulatorMiniApp is dynamically imported inside bootShellSession below.)
const DeviceShell = lazy(() =>
  import('./device-shell/device-shell').then((m) => ({ default: m.DeviceShell })),
)

declare global {
  interface Window {
    __diminaCustomApis?: {
      list: () => Promise<string[]>
      invoke: (name: string, params: unknown) => Promise<unknown>
    }
  }
}

/**
 * How long a pending (soft-reload) session may boot before it is given up on:
 * a session whose root page never reports DOM_READY (e.g. its page was deleted
 * and the manifest gate withheld loadResource) is disposed and the live shell
 * stays — the failure is already surfaced on the service console.
 */
export const SOFT_RELOAD_TIMEOUT_MS = 15_000

/** One booted mini-app session and the DeviceShell identity it renders under. */
interface ShellSession {
  miniApp: SimulatorMiniApp
  bridgeId: string
}

interface ShellSlots {
  /** The visible shell (the phone the user is looking at). */
  current: ShellSession | null
  /** A soft-reload session booting invisibly; promoted on its root DOM_READY. */
  pending: ShellSession | null
}

// Register the built-in devtools APIs (request + simulatorApis) on the mini-app
// instance. `SimulatorMiniApp` exposes `registerApi(name, handler)`.
function registerBuiltinApis(app: {
  registerApi: (name: string, handler: (...args: unknown[]) => unknown) => void
}): void {
  app.registerApi('request', directRequest as (...args: unknown[]) => unknown)
  for (const [name, handler] of Object.entries(
    simulatorApis as Record<string, (...args: unknown[]) => unknown>,
  )) {
    app.registerApi(name, handler)
  }
}

/** Boot options for one session, derived from a simulator-route entry spec. */
function bootSpecFromEntry(appId: string, entry: PageSpec): {
  appId: string
  scene: number
  pagePath: string
  query: Record<string, string>
} {
  const query: Record<string, string> = { ...entry.query }
  const scene = Number(query['scene']) || 1001
  delete query['scene']
  return { appId, scene, pagePath: entry.pagePath, query }
}

// Boot one mini-app session end-to-end: construct, register built-in + custom
// APIs (a hung/absent custom-API bridge degrades to "no custom APIs" rather
// than blocking), spawn. The caller owns staleness checks + dispose.
async function bootShellSession(spec: {
  appId: string
  scene: number
  pagePath: string
  query: Record<string, string>
}): Promise<ShellSession> {
  const { SimulatorMiniApp } = await import('./simulator-mini-app')
  const miniApp = new SimulatorMiniApp(spec)
  registerBuiltinApis(miniApp)
  await registerCustomApis(miniApp, resolveCustomApisBridge())
  const bridgeId = await miniApp.spawn()
  return { miniApp, bridgeId }
}

/**
 * Simulator page root: owns the DeviceShell lifecycle including soft reload
 * (ready-then-swap). On `SIMULATOR_EVENTS.RELAUNCH` it boots a NEW session in
 * the background and mounts its DeviceShell invisibly next to the live one;
 * when the new session's root page reports DOM_READY the two swap in a single
 * commit and the old session is disposed. The phone shell (this WCV) never
 * unmounts, so a recompile no longer blanks the device.
 */
export function SimulatorApp() {
  const [slots, setSlots] = useState<ShellSlots>({ current: null, pending: null })
  // Authoritative slot state for the bridge-event handlers (registered once).
  // Written SYNCHRONOUSLY by commitSlots, never by a passive effect: bridge
  // events arrive outside React's batching, so an effect-synced mirror lags
  // one commit behind — a RELAUNCH landing between a promote's setState and
  // that effect would read the just-promoted session as "pending" and dispose
  // the live shell out from under the user. React state is only the render
  // mirror of this ref.
  const slotsRef = useRef(slots)
  const commitSlots = useCallback((next: ShellSlots): void => {
    slotsRef.current = next
    setSlots(next)
  }, [])
  // Monotonic guard: a RELAUNCH arriving while a previous one is still booting
  // supersedes it (latest wins); the superseded boot's completion self-disposes.
  const relaunchSeqRef = useRef(0)
  const pendingTimerRef = useRef<number | null>(null)

  // ── Initial boot ──────────────────────────────────────────────────────────
  useEffect(() => {
    // `cancelled` guards against presenting onto a component that unmounted
    // during the async boot; the WCV teardown reclaims the session itself.
    let cancelled = false
    void (async () => {
      try {
        const route = parseLocationRoute(window.location.search)
        if (!route) return
        const shell = await bootShellSession(bootSpecFromEntry(route.appId, route.entry))
        if (cancelled) return
        commitSlots({ ...slotsRef.current, current: shell })
      } catch (err) {
        console.error('[simulator] native-host boot failed:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [commitSlots])

  // ── Soft reload (ready-then-swap) ─────────────────────────────────────────
  useEffect(() => {
    const host = window.__diminaNativeHost
    if (!host) return

    const clearPendingTimer = (): void => {
      if (pendingTimerRef.current !== null) {
        window.clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
    }

    const beginSoftReload = async (url: string | undefined): Promise<void> => {
      const seq = ++relaunchSeqRef.current
      // Latest wins: retire an in-flight pending session before booting the
      // next — it will never be shown.
      const stale = slotsRef.current.pending
      if (stale) {
        clearPendingTimer()
        stale.miniApp.dispose()
        commitSlots({ ...slotsRef.current, pending: null })
      }
      const route = url ? parseRoute(url) : null
      if (!route) return
      try {
        const shell = await bootShellSession(bootSpecFromEntry(route.appId, route.entry))
        if (seq !== relaunchSeqRef.current) {
          // Superseded while booting — this session never mounts.
          shell.miniApp.dispose()
          return
        }
        commitSlots({ ...slotsRef.current, pending: shell })
        pendingTimerRef.current = window.setTimeout(() => {
          pendingTimerRef.current = null
          if (slotsRef.current.pending !== shell) return
          console.error('[simulator] soft reload timed out waiting for the new page; keeping the previous content')
          shell.miniApp.dispose()
          commitSlots({ ...slotsRef.current, pending: null })
        }, SOFT_RELOAD_TIMEOUT_MS)
      } catch (err) {
        console.error('[simulator] soft reload boot failed:', err)
      }
    }

    const promoteIfReady = (bridgeId: string | undefined): void => {
      const { current, pending } = slotsRef.current
      if (!pending || !bridgeId || pending.bridgeId !== bridgeId) return
      clearPendingTimer()
      // One commit: the new shell turns visible exactly as the old unmounts.
      // commitSlots updates the authoritative ref synchronously, so a RELAUNCH
      // arriving right after this can no longer see the promoted session as
      // "pending" and dispose the live shell.
      commitSlots({ current: pending, pending: null })
      // The dispose IPC is processed by main asynchronously (cross-process),
      // so the old shell's unmount commits before its guests are closed.
      current?.miniApp.dispose()
    }

    const offRelaunch = host.onSimulatorEvent<RelaunchPayload>(
      SIMULATOR_EVENTS.RELAUNCH,
      (payload) => { void beginSoftReload(payload?.url) },
    )
    const offDomReady = host.onSimulatorEvent<{ bridgeId?: string }>(
      SIMULATOR_EVENTS.DOM_READY,
      (payload) => { promoteIfReady(payload?.bridgeId) },
    )
    return () => {
      offRelaunch()
      offDomReady()
      clearPendingTimer()
    }
  }, [commitSlots])

  // Boot-ordered stable render list: surviving wrapper nodes must never MOVE
  // in the DOM — a moved <webview> re-attaches and reloads its guest (the
  // switchTab lesson). `current` (older) always precedes `pending` (newer), so
  // a promote only REMOVES the old node and restyles the new one in place, and
  // a retired pending is removed from the tail.
  const shells: Array<{ shell: ShellSession; role: 'current' | 'pending' }> = []
  if (slots.current) shells.push({ shell: slots.current, role: 'current' })
  if (slots.pending) shells.push({ shell: slots.pending, role: 'pending' })

  return (
    <Suspense fallback={null}>
      {shells.map(({ shell, role }) => (
        <div
          key={shell.bridgeId}
          data-shell-role={role}
          // Pending boots out-of-flow over the same viewport rect, invisible
          // but laid out — visibility (not display): a display:none <webview>
          // never attaches its guest. Promotion restyles this SAME node in
          // place (display:contents hands layout back to the shell root).
          style={role === 'pending'
            ? { position: 'fixed', inset: 0, visibility: 'hidden' }
            : { display: 'contents' }}
        >
          <DeviceShell
            miniApp={shell.miniApp}
            bridgeId={shell.bridgeId}
            platform={shell.miniApp.platform}
          />
        </div>
      ))}
    </Suspense>
  )
}
