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
  // NATIVE-HOST ONLY: ask main to create the simulator as a top-level
  // WebContentsView (so nested render-host <webview>s can attach). The default
  // path uses `Attach` with the renderer <webview>'s webContents id instead.
  AttachNative: 'simulator:attach-native',
  // NATIVE-HOST ONLY: renderer reports the device-bezel inner-screen rect (CSS
  // px from content top-left) + zoom so main can overlay the simulator WCV on
  // it. The default <webview> path never sends this.
  SetNativeBounds: 'simulator:set-native-bounds',
  Detach: 'simulator:detach',
  Resize: 'simulator:resize',
  SetVisible: 'simulator:setVisible',
  Console: 'simulator:console',
} as const

// ── Custom simulator APIs (downstream-registered, main-process handlers) ──
// list: simulator queries the names registered via instance.registerSimulatorApi().
// invoke: simulator forwards an API call to the registry; result/reject propagates.
//
// These are ipcMain.handle channels invoked by the **main-window renderer**
// only (trusted host). The simulator <webview> never reaches them directly —
// it proxies through the host via the bridge channels below, so the
// sender-policy can keep the webview off the IPC white-list.
export const SimulatorCustomApiChannel = {
  List: 'simulator:custom-apis:list',
  Invoke: 'simulator:custom-apis:invoke',
} as const

// ── Custom APIs bridge proxy (simulator <webview> ↔ main-window renderer) ──
// Request:  webview → host via `ipcRenderer.sendToHost`,
//           payload = { id, op: 'list' } | { id, op: 'invoke', name, params }
// Response: host → webview via `<webview>.send`,
//           payload = { id, result } | { id, error }
//
// Request/response are correlated by `id` so multiple concurrent invokes can
// be in flight at once.
export const SimulatorCustomApiBridgeChannel = {
  Request: 'simulator:custom-apis:bridge-request',
  Response: 'simulator:custom-apis:bridge-response',
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

// ── Workbench runtime info (renderer reads once to pick panel data sources) ──
// Under native-host the page DOM / service logic live in separate webContents,
// so WXML + AppData are sourced from the main process instead of the simulator
// guest's miniappSnapshot transport. The renderer queries this flag once and
// branches usePanelData accordingly.
export const WorkbenchRuntimeChannel = {
  GetNativeHost: 'workbench:runtime:native-host',
} as const

// ── WXML tree (native-host: main pulls the tree from the active render-host
// <webview> guest via render-inspect, and pushes/answers here — mirroring the
// Storage panel's main→renderer contract so the renderer panel is unchanged) ──
export const SimulatorWxmlChannel = {
  GetSnapshot: 'simulator:wxml:snapshot',
  Event: 'simulator:wxml:event',
} as const

// ── AppData (native-host: main taps the service→render setData stream in
// bridge-router and pushes the cumulative snapshot here — the service logic runs
// in the hidden service-host window, not a Worker in the simulator guest) ──
export const SimulatorAppDataChannel = {
  GetSnapshot: 'simulator:appdata:snapshot',
  Event: 'simulator:appdata:event',
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

// ── Workbench settings ───────────────────────────────────────────────────

export const WorkbenchSettingsChannel = {
  Get: 'workbenchSettings:get',
  Save: 'workbenchSettings:save',
  SetTheme: 'workbenchSettings:setTheme',
  GetCdpStatus: 'workbenchSettings:getCdpStatus',
  GetMcpStatus: 'workbenchSettings:getMcpStatus',
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

// ── Project file system (sandboxed to active project root) ────────────────
//
// Read/write access to the active project's files, used by the in-renderer
// Monaco editor. Every path is verified against the active project root in
// the main process (see `services/project-fs`). Replaces the OpenSumi
// editor's `editor:fs:*` bridge — same sandbox, callable from the main
// renderer instead of a separate WebContentsView.

export const ProjectFsChannel = {
  GetRoot: 'project:fs:getRoot',
  ReadFile: 'project:fs:readFile',
  WriteFile: 'project:fs:writeFile',
  /**
   * Synchronous (blocking) write, used ONLY by the editor's `beforeunload`
   * flush: a hard window/app close tears the renderer down before an async
   * `WriteFile` IPC can round-trip, so the last in-debounce-window edit would
   * be lost. `sendSync` blocks page teardown until the bytes hit disk. Runs the
   * SAME sandbox as `WriteFile` (see project-fs `writeFileSync`).
   */
  WriteFileSync: 'project:fs:writeFileSync',
  ListFiles: 'project:fs:listFiles',
} as const

// ── Project list / workspace ─────────────────────────────────────────────

export const ProjectsChannel = {
  List: 'projects:list',
  Add: 'projects:add',
  Remove: 'projects:remove',
  /** Phase 3: merged + sanitized template catalog for the create-project dialog. */
  ListTemplates: 'projects:listTemplates',
  /** Phase 3: host-supplied create-project dialog hook (returns input or null). */
  OpenCreateDialog: 'projects:openCreateDialog',
  /** Phase 3: server-side scaffold + register (delegates to create-project-service). */
  Create: 'projects:create',
  /** Default values used to pre-fill the create-project dialog (baseDir). */
  GetCreateDefaults: 'projects:getCreateDefaults',
} as const

/** Renderer-facing payload for `projects:getCreateDefaults`. */
export interface ProjectCreateDefaults {
  /** Absolute directory used as the parent for new projects. */
  baseDir: string
}

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

// ── Embedded views (renderer → main) ─────────────────────────────────────
//
// The main window's React layout owns the *positions* of the editor +
// simulator-DevTools WebContentsView overlays — each visible placeholder
// `<div>` measures its client rect via ResizeObserver and pushes the
// rectangle to the main process. The view manager caches the latest
// payload per kind and applies it to the overlay; no payload means the
// overlay is hidden.
//
// Payload (after schema validation): `{ x, y, width, height }` in CSS
// pixels relative to the window's content area (origin = top-left,
// not including the OS chrome).
export const ViewChannel = {
  /** Update the simulator DevTools view's bounds (or hide if w/h = 0). */
  SimulatorDevtoolsBounds: 'view:simulator:devtools-bounds',
} as const

export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

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
  /** Invoke a toolbar action by id: `invoke(Invoke, actionId)`. */
  Invoke: 'toolbar:invoke',
} as const

// ── Window ───────────────────────────────────────────────────────────────

export const WindowChannel = {
  NavigateBack: 'window:navigateBack',
} as const

// ── App ──────────────────────────────────────────────────────────────────

export const AppChannel = {
  GetPreloadPath: 'app:getPreloadPath',
  GetBranding: 'app:getBranding',
  GetHeaderHeight: 'app:getHeaderHeight',
} as const

// ── miniappSnapshot (unified panel snapshot framework) ───────────────────
//
// Two generic channels shared by every snapshot source (AppData, WXML, …).
// Adding a new panel needs no new channel.
//   Push: preload → renderer (`sendToHost`), payload: SnapshotEnvelope
//   Pull: renderer → preload (`webview.send`),  payload: { id }

export const MiniappSnapshotChannel = {
  Push: 'miniapp-snapshot:push',
  Pull: 'miniapp-snapshot:pull',
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
