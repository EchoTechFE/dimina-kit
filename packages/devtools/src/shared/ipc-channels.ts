/**
 * Centralised IPC channel name constants for dimina-devtools.
 *
 * Every raw channel string used across main, renderer, preload and e2e code
 * should reference one of these constants so that renaming a channel only
 * requires a single edit.
 */

// ── Simulator (preload → host / renderer ↔ main) ────────────────────────

export const SimulatorChannel = {
  Attach: 'simulator:attach',
  Detach: 'simulator:detach',
  Resize: 'simulator:resize',
  SetVisible: 'simulator:setVisible',
  Console: 'simulator:console',
  Wxml: 'simulator:wxml',
  AppData: 'simulator:appdata',
  AppDataAll: 'simulator:appdata-all',
} as const

// ── Custom simulator APIs (downstream-registered, main-process handlers) ──
// list: simulator queries the names registered via @dimina-kit/devtools/simulator-apis.
// invoke: simulator forwards an API call to the registry; result/reject propagates.
export const SimulatorCustomApiChannel = {
  List: 'simulator:custom-apis:list',
  Invoke: 'simulator:custom-apis:invoke',
} as const

// ── Storage (CDP-backed; main process attaches the debugger to the
// simulator <webview> and forwards DOMStorage events to the renderer) ──
export const SimulatorStorageChannel = {
  GetSnapshot: 'simulator:storage:snapshot',
  GetActivePrefix: 'simulator:storage:activePrefix',
  Set: 'simulator:storage:set',
  Remove: 'simulator:storage:remove',
  Clear: 'simulator:storage:clear',
  ClearAll: 'simulator:storage:clearAll',
  Event: 'simulator:storage:event',
} as const

export interface StorageItem { key: string; value: string }
export type StorageEvent =
  | { type: 'added'; key: string; newValue: string }
  | { type: 'updated'; key: string; oldValue: string; newValue: string }
  | { type: 'removed'; key: string }
  | { type: 'cleared' }

export type StorageWriteResult =
  | { ok: true }
  | { ok: false; error: string }

// ── Element inspection (CDP-backed; WXML tree nodes map to real DOM by sid) ──
export const SimulatorElementChannel = {
  Inspect: 'simulator:element:inspect',
  Clear: 'simulator:element:clear',
} as const

export interface ElementInspection {
  sid: string
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
  style: {
    display: string
    position: string
    boxSizing: string
    margin: string
    padding: string
    color: string
    backgroundColor: string
    fontSize: string
  }
}

// ── Workbench ────────────────────────────────────────────────────────────

export const WorkbenchChannel = {
  GetPanelConfig: 'workbench:getPanelConfig',
  GetApiNamespaces: 'workbench:getApiNamespaces',
  Reset: 'workbench:reset',
} as const

// ── Workbench settings ───────────────────────────────────────────────────

export const WorkbenchSettingsChannel = {
  Get: 'workbenchSettings:get',
  Save: 'workbenchSettings:save',
  SetTheme: 'workbenchSettings:setTheme',
  GetCdpStatus: 'workbenchSettings:getCdpStatus',
  SetVisible: 'workbenchSettings:setVisible',
  Init: 'workbenchSettings:init',
} as const

// ── Project session ──────────────────────────────────────────────────────

export const ProjectChannel = {
  Open: 'project:open',
  Close: 'project:close',
  GetPages: 'project:getPages',
  GetCompileConfig: 'project:getCompileConfig',
  SaveCompileConfig: 'project:saveCompileConfig',
  Status: 'project:status',
  CaptureThumbnail: 'project:captureThumbnail',
  GetThumbnail: 'project:getThumbnail',
} as const

// ── Project list / workspace ─────────────────────────────────────────────

export const ProjectsChannel = {
  List: 'projects:list',
  Add: 'projects:add',
  Remove: 'projects:remove',
} as const

// ── Dialog ───────────────────────────────────────────────────────────────

export const DialogChannel = {
  OpenDirectory: 'dialog:openDirectory',
} as const

// ── Panels ───────────────────────────────────────────────────────────────

export const PanelChannel = {
  List: 'panel:list',
  Eval: 'panel:eval',
  Select: 'panel:select',
  SelectSimulator: 'panel:selectSimulator',
} as const

// ── Popover ──────────────────────────────────────────────────────────────

export const PopoverChannel = {
  Show: 'popover:show',
  Hide: 'popover:hide',
  Relaunch: 'popover:relaunch',
  Closed: 'popover:closed',
  Init: 'popover:init',
} as const

// ── Toolbar ──────────────────────────────────────────────────────────────

export const ToolbarChannel = {
  GetActions: 'toolbar:getActions',
  ActionsChanged: 'toolbar:actionsChanged',
  /** Prefix for dynamic action channels: `toolbar:action:${actionId}` */
  ActionPrefix: 'toolbar:action:',
} as const

// ── Window ───────────────────────────────────────────────────────────────

export const WindowChannel = {
  NavigateBack: 'window:navigateBack',
} as const

// ── App ──────────────────────────────────────────────────────────────────

export const AppChannel = {
  GetPreloadPath: 'app:getPreloadPath',
  GetBranding: 'app:getBranding',
} as const

// ── Bridge (renderer ↔ preload, webview.send / sendToHost) ───────────────

export const BridgeChannel = {
  WxmlRefreshRequest: 'wxml:refresh:request',
  AppDataGetAllRequest: 'appdata:getAll:request',
  AppDataGetAllResponse: 'appdata:getAll:response',
} as const

// ── Automation (WebSocket server) ────────────────────────────────────────

export const AutomationChannel = {
  GetPort: 'automation:port',
} as const

// ── Embedded settings overlay ────────────────────────────────────────────

export const SettingsChannel = {
  SetVisible: 'settings:setVisible',
  ConfigChanged: 'settings:configChanged',
  ProjectSettingsChanged: 'settings:projectSettingsChanged',
  Init: 'settings:init',
  Closed: 'settings:closed',
  Changed: 'settings:changed',
} as const

// ── Updates (UpdateManager) ──────────────────────────────────────────────
//
// String values are FROZEN: shipped builds key off them. Add new entries
// here, never rename existing ones.
export const UpdateChannel = {
  Check: 'updates:check',
  Download: 'updates:download',
  Install: 'updates:install',
  DownloadProgress: 'updates:downloadProgress',
  Available: 'updates:available',
} as const
