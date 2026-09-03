import type { BrowserWindow } from 'electron'
import type { ConsoleForwarder } from '../services/console-forward/index.js'
import type { DiagnosticsBus } from '../services/diagnostics/index.js'
import type { CdpSessionBroker } from '../services/cdp-session/index.js'
import type { InternalDevtoolsWindow } from '../windows/internal-devtools-window/index.js'
import { createGlobalConsoleMirror } from '../services/console-forward/global-console-mirror.js'
import { createGlobalDiagnosticsMirror } from '../services/console-forward/global-diagnostics-mirror.js'
import { toDisposable, type DisposableRegistry } from '@dimina-kit/electron-deck/main'

/** Narrow view of the context fields the two global mirrors depend on. */
export interface GlobalMirrorContext {
  consoleForwarder?: ConsoleForwarder
  diagnostics?: DiagnosticsBus
  internalDevtoolsWindow?: InternalDevtoolsWindow
  cdpSessionBroker: CdpSessionBroker
  registry: DisposableRegistry
}

/**
 * Console + diagnostics mirrors into the standalone internal DevTools window.
 *
 * Both mirrors target the INSPECTED side — `mainWindow.webContents`, per
 * internal-devtools-window.ts's setDevToolsWebContents relationship — and NOT
 * the front-end host page the `onHostChanged` callback hands them.
 */
export function installGlobalMirrors(context: GlobalMirrorContext, mainWindow: BrowserWindow): void {
  // While the standalone internal DevTools window is open, mirror every guest
  // console entry (service + render, UNFILTERED — see global-console-mirror.ts)
  // into it — each open replays the forwarder's current history buffer first
  // (see that module's doc comment for why the subscribe lifecycle is gated on
  // onHostChanged rather than subscribed once at construction time).
  // `context.consoleForwarder` is assembled by the simulator module's
  // installBridgeRouter; absent only when that builtin module was disabled via
  // config.
  if (context.consoleForwarder && context.internalDevtoolsWindow) {
    const consoleMirror = createGlobalConsoleMirror(
      context.consoleForwarder,
      mainWindow.webContents,
      context.internalDevtoolsWindow.onHostChanged,
      // CDP transport (never executeJavaScript) — see the mirror's inject()
      // doc for the setDevToolsWebContents + external-CDP double-attach hang.
      { broker: context.cdpSessionBroker },
    )
    context.registry.add(toDisposable(() => consoleMirror.dispose()))
  }

  // Same wiring for diagnostics: every diagnostic — including
  // `audience:'internal'` ones console-forward's own service-host injection
  // now skips (see compile-standby.ts / index.ts's handleDiagnostic gate) —
  // surfaces here instead of vanishing. `context.diagnostics` is assembled
  // alongside `context.consoleForwarder` by the same installBridgeRouter call.
  if (context.diagnostics && context.internalDevtoolsWindow) {
    const diagnosticsMirror = createGlobalDiagnosticsMirror(
      context.diagnostics,
      mainWindow.webContents,
      context.internalDevtoolsWindow.onHostChanged,
      { broker: context.cdpSessionBroker },
    )
    context.registry.add(toDisposable(() => diagnosticsMirror.dispose()))
  }
}
