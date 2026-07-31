import type { BrowserWindow } from 'electron'
import type {
  ConnectionRegistry,
  DisposableRegistry,
} from '@dimina-kit/electron-deck/main'
import type { BridgeRouterHandle } from './ipc/bridge-router.js'
import type { ConsoleForwarder } from './services/console-forward/index.js'
import type { DiagnosticsBus } from './services/diagnostics/index.js'
import type { RuntimeStorageApi } from './services/storage.js'
import type { SimulatorApiRegistry } from './services/simulator/custom-apis.js'
import type { RuntimeEvents } from './runtime-events.js'
import type { RuntimeAssetPaths } from './utils/paths.js'

export { createRuntimeEvents } from './runtime-events.js'
export type { RuntimeEvents } from './runtime-events.js'

export interface RuntimeWorkspace {
  getSession(): { appInfo: { appId: string } } | null
  getProjectPath(): string
  isClosing(): boolean
}

/** Main-process dependencies consumed by the native mini-app bridge. */
export interface RuntimeContext {
  apiNamespaces: string[]
  /** Resolved lazily by low-level consumers when omitted. */
  assets?: RuntimeAssetPaths
  workspace: RuntimeWorkspace
  windows: { mainWindow: BrowserWindow }
  registry: DisposableRegistry
  connections: ConnectionRegistry
  simulatorApis: SimulatorApiRegistry
  events: RuntimeEvents
  storageApi?: RuntimeStorageApi
  bridge?: BridgeRouterHandle
  consoleForwarder?: ConsoleForwarder
  diagnostics?: DiagnosticsBus
  guestConsole?: { emit(entry: unknown): void }
}
