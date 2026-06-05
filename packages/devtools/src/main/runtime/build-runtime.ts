/**
 * `buildRuntime` — constructs the spec `Runtime` facade (workbench-model.md §3.2)
 * that a host receives in `config.setup(runtime)`.
 *
 * It is a thin PROJECTION of the devtools-real `WorkbenchContext`
 * (`services/workbench-context.ts`) plus injected Electron handles — not a
 * clone. Injected handles pass through by reference; `runtime.context` projects
 * the devtools context into the spec `WorkbenchContext` shape.
 *
 * Honesty notes (fields the devtools context does not currently source):
 *  - `context.theme` / `context.settings`: devtools has no top-level live theme
 *    source (per-project settings live on the workspace), so these are a
 *    documented placeholder ('dark') until a real theme channel is wired.
 *  - `context.workspaceOps.on('session-changed')`: `WorkspaceService` does not
 *    emit session-change events yet, so this returns an inert Disposable.
 *  - `WorkbenchSession.startedAt`: the devtools session carries no start
 *    timestamp, projected as 0.
 *  - `call.host`: there is no host-service dispatch surface on the devtools
 *    context; it delegates to an injected `callHost` (supplied by the
 *    contributions binding) and throws if host services were not configured.
 */
import type { BrowserWindow, WebContentsView } from 'electron'

import type {
  JsonValue,
  Runtime,
  TypedIpcRegistry,
  WorkbenchContext as SpecWorkbenchContext,
} from '@dimina-kit/workbench'
import type { WorkbenchContext } from '../services/workbench-context.js'

export interface BuildRuntimeDeps {
  electron: typeof import('electron')
  ctx: WorkbenchContext
  mainWindow: BrowserWindow
  toolbarView: WebContentsView | null
  ipc: TypedIpcRegistry
  rawIpcMain: typeof import('electron').ipcMain
  windowsCtl: Runtime['windows']
  busOn: Runtime['on']
  /** Host-service RPC dispatch; supplied by the contributions binding (U4). */
  callHost?: (name: string, ...args: JsonValue[]) => Promise<JsonValue>
}

export function buildRuntime(deps: BuildRuntimeDeps): Runtime {
  const { ctx } = deps

  const context: SpecWorkbenchContext = {
    get workspace() {
      const path = ctx.workspace.getProjectPath()
      const session = ctx.workspace.getSession()
      return {
        activeProjectPath: path === '' ? null : path,
        session: session
          ? { projectPath: path, port: session.port, startedAt: 0 }
          : null,
      }
    },
    // Documented placeholder — no live theme source on the devtools context yet.
    get theme() {
      return 'dark' as const
    },
    get settings() {
      return { theme: 'dark' as const }
    },
    workspaceOps: {
      openProject: async (path: string) => {
        await ctx.workspace.openProject(path)
      },
      closeProject: () => ctx.workspace.closeProject(),
      // WorkspaceService emits no session-change events yet — inert Disposable.
      on: () => ({ dispose: () => {} }),
    },
    // DisposableRegistry structurally satisfies ResourceRegistry (add/disposeAll).
    _registry: ctx.registry,
    _senderPolicy: {
      isTrusted: (senderId: number): boolean => {
        const wc = deps.electron.webContents?.fromId(senderId)
        return wc ? ctx.senderPolicy(wc) : false
      },
    },
  }

  return {
    electron: deps.electron,
    mainWindow: deps.mainWindow,
    toolbarView: deps.toolbarView,
    ipc: deps.ipc,
    rawIpcMain: deps.rawIpcMain,
    call: {
      simulator: async (name: string, ...args: JsonValue[]): Promise<JsonValue> => {
        const params = args.length <= 1 ? args[0] : args
        return (await ctx.simulatorApis.invoke(name, params)) as JsonValue
      },
      host: async (name: string, ...args: JsonValue[]): Promise<JsonValue> => {
        if (!deps.callHost) {
          throw new Error(`runtime.call.host("${name}"): host services not configured`)
        }
        return deps.callHost(name, ...args)
      },
    },
    windows: deps.windowsCtl,
    context,
    on: deps.busOn,
    add: (d) => ctx.registry.add(d),
  }
}
