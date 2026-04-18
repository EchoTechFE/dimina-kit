import { app } from 'electron'
import { loadWorkbenchSettings } from '../services/settings/index.js'

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
    app.commandLine.appendSwitch('remote-debugging-port', String(settings.cdp.port || 9222))
  }
}
