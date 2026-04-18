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
  Storage: 'simulator:storage',
  StorageAll: 'simulator:storage-all',
} as const

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
  StorageGetAllRequest: 'storage:getAll:request',
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
