import { app } from 'electron'
import type { WorkbenchAppInstance } from './app.js'
import { startAutomationServer } from '../services/automation/index.js'
import { startMcpServer, type McpOpenedProject } from '../services/mcp/index.js'
import { loadWorkbenchSettings } from '../services/settings/index.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { SessionStatusStore } from '../services/workspace/session-status-store.js'
import type { CompileLogBuffer } from '../services/workspace/compile-log-buffer.js'
import type { RendererNotifier } from '../services/notifications/renderer-notifier.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'

/** Narrow view of the context fields the MCP project host reads. */
export interface McpHostContext {
  workspace: WorkspaceService
  sessionStatus: SessionStatusStore
  compileLogBuffer: CompileLogBuffer
  notify: RendererNotifier
}

/** Parse --auto, --auto-port, --project from process.argv. */
function parseAutoArgs(): { auto: boolean; autoPort: number; projectPath: string } {
  const argv = process.argv
  let auto = false
  let autoPort = 9420
  let projectPath = ''

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === 'auto' || argv[i] === '--auto') auto = true
    if ((argv[i] === '--auto-port' || argv[i] === '--auto_port') && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1]!, 10)
      // 0 → OS-assigned free port (used by parallel e2e workers)
      if (Number.isFinite(parsed) && parsed >= 0) autoPort = parsed
    }
    if (argv[i] === '--project' && argv[i + 1]) {
      projectPath = argv[i + 1]!
    }
  }

  return { auto, autoPort, projectPath }
}

/**
 * The automation server outlives every window: it binds its port at boot,
 * before any project is open, so it cannot capture a context at start and
 * takes `getContext` instead. What that resolver hands back is only the
 * starting point — each connection pins the first project window it reaches
 * and stays there, so window focus cannot redirect a live client.
 */
export async function setupAutomation(
  instance: WorkbenchAppInstance,
  getContext: Parameters<typeof startAutomationServer>[0],
  senders: Parameters<typeof startAutomationServer>[1],
): Promise<Disposable | null> {
  // Start automation server if --auto flag is present
  const autoArgs = parseAutoArgs()
  if (!autoArgs.auto) return null
  const server = await startAutomationServer(getContext, senders, autoArgs.autoPort)
  instance.automationServer = server
  // Stable, parseable line for e2e harnesses that scrape stdout.
  console.log(`[automation] listening on ws://127.0.0.1:${server.port}`)
  return { dispose: () => server.close() }
}

export function setupMcp(
  getContext: () => McpHostContext,
  openProjectWindow: (project: { path: string; name: string }) => Promise<McpOpenedProject>,
  pinActiveProjectWindow: () => (() => void) | null,
): Disposable | null {
  const settings = loadWorkbenchSettings()
  if (!settings.mcp.enabled) return null

  const cdpPortSwitch = app.commandLine.getSwitchValue('remote-debugging-port')
  const cdpPort = cdpPortSwitch ? parseInt(cdpPortSwitch, 10) : settings.cdp.port
  // Getters, not a snapshot: the project MCP drives lives in whichever
  // workbench window is active, and that changes as windows open and close.
  return startMcpServer(cdpPort, settings.mcp.port, {
    get workspace() { return getContext().workspace },
    get sessionStatus() { return getContext().sessionStatus },
    get compileLogs() { return getContext().compileLogBuffer },
    // A project opens into its own window; the renderer entry mounted there
    // compiles it and attaches the simulator.
    requestOpenInUi: (p) => openProjectWindow(p),
    pinActiveProjectWindow,
  })
}
