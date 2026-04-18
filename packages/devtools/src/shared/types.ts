export interface AppInfo {
  appName?: string
  [key: string]: unknown
}

export interface ProjectSession {
  close: () => Promise<void>
  port: number
  appInfo: AppInfo | unknown
}

export interface CompilationAdapter {
  openProject(opts: {
    projectPath: string
    port?: number
    sourcemap?: boolean
    simulatorDir?: string
    onRebuild?: () => void
    onBuildError?: (err: unknown) => void
  }): Promise<ProjectSession>
}

export type BuiltinPanelId = 'wxml' | 'console' | 'appdata' | 'storage'
export type BuiltinModuleId = 'projects' | 'session' | 'simulator' | 'popover' | 'settings'

export interface ToolbarAction {
  id: string
  label: string
}

export interface WorkbenchConfig {
  /** Window title, default 'Dimina DevTools' */
  appName?: string
  /** Compilation adapter */
  adapter?: CompilationAdapter
  /** Built-in panel IDs to display, default all four */
  panels?: BuiltinPanelId[]
  /** Absolute path to a custom preload script (overrides built-in simulator.js) */
  preloadPath?: string
  /** Custom API namespace names (e.g. ['qd']) passed to the simulator */
  apiNamespaces?: string[]
  /** Provider for branding info (overrides default appName) */
  brandingProvider?: () => Promise<{ appName: string }> | { appName: string }
  /** Provider for toolbar actions shown above the compile toolbar */
  toolbarActions?: () => Promise<ToolbarAction[]> | ToolbarAction[]
}

export interface CompileConfig {
  startPage: string
  scene: number
  queryParams: { key: string; value: string }[]
}

export interface IpcResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface WorkbenchWindowConfig {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
}

/**
 * The instance passed to host hooks (menuBuilder, onSetup, onBeforeClose).
 * `context` is a WorkbenchContext — import it from '@dimina-kit/devtools/context' for full typing.
 */
export interface WorkbenchHostInstance {
  mainWindow: import('electron').BrowserWindow
  context: import('../main/services/workbench-context.js').WorkbenchContext
}

export interface WorkbenchAppConfig extends WorkbenchConfig {
  /** Absolute path to the renderer dist directory. Defaults to dimina-devtools' built-in renderer. */
  rendererDir?: string
  /** Enable or disable built-in IPC module groups. Defaults to all enabled. */
  modules?: Partial<Record<BuiltinModuleId, boolean>>
  /** Window sizing overrides for the main devtools window. */
  window?: WorkbenchWindowConfig
  /** Absolute path to a window/taskbar icon (png or ico). macOS uses the app bundle icon. */
  icon?: string
  /** Custom menu builder. Should call Menu.setApplicationMenu(). If omitted, the default dimina-devtools menu is installed. */
  menuBuilder?: (mainWindow: import('electron').BrowserWindow, context: WorkbenchHostInstance['context']) => void
  /** Called after window and context are created but before start() resolves. Use to register custom IPC handlers. */
  onSetup?: (instance: WorkbenchHostInstance) => void | Promise<void>
  /** Called before window close when a session is active. Session disposal happens automatically after this hook. */
  onBeforeClose?: (instance: WorkbenchHostInstance) => void | Promise<void>
}
