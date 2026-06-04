import { app, protocol } from 'electron'
import { DEFAULT_CDP_PORT } from '../../shared/constants.js'
import { loadWorkbenchSettings } from '../services/settings/index.js'

let difileSchemeRegistered = false

/**
 * Register `difile://` as a privileged scheme so `simSession.protocol.handle`
 * can serve `difile://devtools/{uuid}` URLs from the simulator webview without
 * tripping CSP / fetch-API restrictions. Must be called before `app.whenReady`.
 *
 * Idempotent — subsequent calls are no-ops because Electron throws if the same
 * scheme is registered twice.
 */
export function registerDifileScheme(): void {
  if (difileSchemeRegistered) return
  difileSchemeRegistered = true
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'difile',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ])
}

/**
 * Suppress EPIPE errors on stdout/stderr.
 * Call at the very top of your entry file, before any imports that may write.
 */
export function suppressEpipe(): void {
  function ignore(stream: NodeJS.WriteStream): void {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return
      throw err
    })
  }
  ignore(process.stdout)
  ignore(process.stderr)
}

/**
 * Silence Electron's built-in "Insecure Content-Security-Policy" dev warning.
 *
 * In dev (unpackaged) the renderer is served from the Vite dev server, which
 * does not ship a strict CSP header, so Electron prints its `Electron Security
 * Warning (Insecure Content-Security-Policy)` notice in every frame's console.
 * It is pure dev noise — Electron already suppresses it automatically once the
 * app is packaged (`app.isPackaged`).
 *
 * This sets ONLY the log-suppression env var, and ONLY when unpackaged. It does
 * not touch contextIsolation / sandbox / webSecurity or any other CSP-relevant
 * window setting — the actual security posture is unchanged; we only stop the
 * console from re-printing the warning. Must run before any window is created
 * (Electron reads the env var when it emits the warning).
 */
export function suppressInsecureCspWarnings(): void {
  if (app.isPackaged) return
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

/**
 * Configure Chrome DevTools Protocol remote-debugging-port.
 * Must be called before `app.whenReady()`.
 *
 * Priority: DIMINA_DEBUG_PORT env > workbench-settings.json > dev-mode default.
 * MCP requires CDP, so enabling MCP implicitly enables CDP on its configured port.
 */
export function setupCdpPort(): void {
  if (app.commandLine.getSwitchValue('remote-debugging-port')) return

  const envPort = process.env.DIMINA_DEBUG_PORT
  if (envPort) {
    app.commandLine.appendSwitch('remote-debugging-port', envPort)
    return
  }

  const settings = loadWorkbenchSettings()
  if (settings.cdp.enabled || settings.mcp.enabled) {
    app.commandLine.appendSwitch('remote-debugging-port', String(settings.cdp.port))
  } else if (!app.isPackaged) {
    app.commandLine.appendSwitch('remote-debugging-port', String(settings.cdp.port || DEFAULT_CDP_PORT))
  }
}
