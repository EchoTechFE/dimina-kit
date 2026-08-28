/**
 * Centralised IPC channel name constants for dimina-devtools.
 *
 * Every raw channel string used across main, renderer, preload and e2e code
 * should reference one of these constants so that renaming a channel only
 * requires a single edit.
 */

// ── Simulator (preload → host / renderer ↔ main) ────────────────────────

export const SimulatorChannel = {
  // Ask main to create the simulator as a top-level WebContentsView (so nested
  // render-host <webview>s can attach). Native-host is the sole runtime.
  AttachNative: 'simulator:attach-native',
  // Renderer pushes the selected device's LOGICAL metrics (screen size,
  // pixelRatio, statusBarHeight, …) when the device dropdown changes. Main
  // maps it to a HostEnvSnapshot and live-updates the running service-host
  // window — the authoritative `wx.getSystemInfoSync()` source — so the
  // mini-app sees the selected device without a relaunch.
  SetDeviceInfo: 'simulator:set-device-info',
  // Ask main to soft-reload the LIVE simulator WCV after a watcher rebuild:
  // main forwards a SIMULATOR_EVENTS.RELAUNCH into the shell (which boots a
  // new app session and swaps when ready) instead of destroying the view.
  // Resolves false when there is no live+ready shell — the renderer then falls
  // back to the hard AttachNative rebuild.
  SoftReload: 'simulator:soft-reload',
  Detach: 'simulator:detach',
  Console: 'simulator:console',
  // Main → renderer push of the visible top-of-stack page route whenever the
  // mini-app navigates (navigateTo / switchTab / back). Payload: the page
  // route string (`pagePath` + `?k=v&…` query, same format as
  // `encodePageSpec`/`decodePageSpec`), or '' when unknown. The query lets the
  // page-path bar show params (WeChat DevTools parity) and a recompile restore
  // the current page's params.
  CurrentPage: 'simulator:current-page',
} as const

/** iPhone bezel cutout family driving the device-shell notch visual. */
export type {
  NativeDeviceInfo,
  NotchType,
  SafeAreaInsets,
} from '@dimina-kit/electron-runtime'

// ── Service host (main → hidden service-host window) ─────────────────────

export const ServiceHostChannel = {
  /**
   * NATIVE-HOST ONLY. Live-update the service-host window's host-env snapshot
   * (device metrics) so subsequent `wx.getSystemInfoSync()` reflects a device
   * change without a relaunch. The service-host preload mutates
   * `__diminaSpawnContext.hostEnvSnapshot` in place (see `service-host/preload.cjs`).
   */
  HostEnvUpdate: 'service-host:host-env:update',
  /**
   * NATIVE-HOST ONLY. Deliver an AppData-panel edit (`{bridgeId, data}`) into
   * the service-host window. The preload resolves the page instance via
   * `getCurrentPages()` and calls `page.setData(data)`, so the resulting `ub`
   * publish flows back through the normal service→render tap — the panel
   * refreshes from the runtime's own state, not an optimistic local echo.
   */
  AppDataSetData: 'service-host:appdata:set-data',
} as const

// ── Custom simulator APIs (downstream-registered, main-process handlers) ──
// invoke: forwards an API call to the registry; result/reject propagates.
//
// This is an ipcMain.handle channel invoked by the **main-window renderer**
// only (trusted host). The simulator guest never reaches it directly — it
// reaches the host via the bridge channels below, so the sender-policy can keep
// the simulator off the IPC white-list.
export const SimulatorCustomApiChannel = {
  Invoke: 'simulator:custom-apis:invoke',
} as const

// ── Custom APIs bridge (simulator → host) ──
// payload = { id, op: 'list' } | { id, op: 'invoke', name, params } for Request,
// { id, result } | { id, error } for Response. Transport (in
// `src/preload/runtime/custom-apis.ts`): native-host — the simulator is a
// top-level WebContentsView (no embedder), so Request goes via
// `ipcRenderer.send` → `ipcMain.on` dispatcher bound to that simWc (view-manager
// `attachNativeCustomApiBridge`) → Response via `simWc.send`. (The old
// renderer-proxied `<webview>` transport, `ipcRenderer.sendToHost` →
// `<webview>.send`, no longer exists — native-host is the sole runtime.)
//
// Request/response are correlated by `id` so multiple concurrent invokes can
// be in flight at once. The standalone runtime owns the wire contract.
export {
  SimulatorCustomApiBridgeChannel,
} from '@dimina-kit/electron-runtime/shared/bridge-channels'

// ── Storage (CDP-backed; main process attaches the debugger to the
// simulator guest and forwards DOMStorage events to the renderer) ──
export const SimulatorStorageChannel = {
  GetSnapshot: 'simulator:storage:snapshot',
  GetActivePrefix: 'simulator:storage:activePrefix',
  Set: 'simulator:storage:set',
  Remove: 'simulator:storage:remove',
  Clear: 'simulator:storage:clear',
  ClearAll: 'simulator:storage:clearAll',
  Event: 'simulator:storage:event',
} as const

// The storage wire-format shapes are owned by the shared inspect package
// (any host's transport carries the same StorageItem/StorageEvent/
// StorageWriteResult); this channel file re-exports them so IPC consumers
// keep a single import point.
export type { StorageEvent, StorageItem, StorageWriteResult } from '@dimina-kit/inspect'

/**
 * A storage mutation reported by the service-host's SYNC wx storage APIs
 * (`setStorageSync`/`removeStorageSync`/`clearStorageSync`). Those run inside the
 * service-host window and write `localStorage` directly, so — unlike the async
 * path (`runtimeInvoke`) and the panel's own writes — they never pass through
 * main and would otherwise leave the Storage panel stale until a manual reload.
 * The service-host posts this over `DiminaServiceBridge` as a `storageChanged`
 * container message; bridge-router hands it to `onServiceStorageChanged`, which
 * pushes the matching `StorageEvent` to the panel. `key` carries the full
 * `${appId}_` prefix (same wire shape as the CDP / async paths).
 */
export type SyncStorageChange =
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string }
  | { op: 'clear' }

// ── Element inspection (CDP-backed; WXML tree nodes map to real DOM by sid) ──
export const SimulatorElementChannel = {
  Inspect: 'simulator:element:inspect',
  Clear: 'simulator:element:clear',
} as const

// ── WXML tree (native-host: main pulls the tree from the active render-host
// <webview> guest via render-inspect, and pushes/answers here — mirroring the
// Storage panel's main→renderer contract so the renderer panel is unchanged) ──
export const SimulatorWxmlChannel = {
  GetSnapshot: 'simulator:wxml:snapshot',
  Event: 'simulator:wxml:event',
  // renderer→main: whether the WXML panel is currently visible/active. Main
  // only installs the render-guest DOM MutationObserver + pushes live tree
  // updates while active, so an unseen panel never drives a full Vue-tree walk.
  SetActive: 'simulator:wxml:setActive',
} as const

// ── AppData (native-host: main taps the service→render setData stream in
// bridge-router and pushes the cumulative snapshot here — the service logic runs
// in the hidden service-host window, not a Worker in the simulator guest) ──
export const SimulatorAppDataChannel = {
  GetSnapshot: 'simulator:appdata:snapshot',
  Event: 'simulator:appdata:event',
  // renderer → main invoke: write an AppData-panel edit back into the running
  // page (forwarded to the service host via ServiceHostChannel.AppDataSetData).
  SetData: 'simulator:appdata:set-data',
} as const

// The element-inspection payload shape is owned by the shared inspect
// package (it is produced inside render-layer documents by any host); this
// channel file re-exports it so IPC consumers keep a single import point.
export type { ElementInspection } from '@dimina-kit/inspect'

// ── Workbench settings ───────────────────────────────────────────────────

export const WorkbenchSettingsChannel = {
  Get: 'workbenchSettings:get',
  Save: 'workbenchSettings:save',
  SetTheme: 'workbenchSettings:setTheme',
  Restart: 'workbenchSettings:restart',
  GetCdpStatus: 'workbenchSettings:getCdpStatus',
  GetMcpStatus: 'workbenchSettings:getMcpStatus',
  Init: 'workbenchSettings:init',
  // Main → renderer push: the active color scheme flipped (OS change or in-app
  // SetTheme). Payload is `isDark: boolean`. The app's CSS reacts to
  // `prefers-color-scheme` automatically; this exists for the few JS consumers
  // (Monaco's theme) that can't observe that media change — Electron does NOT
  // dispatch the renderer's `matchMedia('(prefers-color-scheme)')` change event
  // for programmatic `nativeTheme.themeSource` assignments.
  ThemeChanged: 'workbenchSettings:themeChanged',
} as const

// ── Project session ──────────────────────────────────────────────────────

export const ProjectChannel = {
  Open: 'project:open',
  Close: 'project:close',
  // Renderer → main invoke: run one real recompile of the active session
  // (the popover 重新编译 button). Resolves `{ supported: boolean }`; rejects
  // on build failure or when no session is active.
  Rebuild: 'project:rebuild',
  GetPages: 'project:getPages',
  GetCompileConfig: 'project:getCompileConfig',
  SaveCompileConfig: 'project:saveCompileConfig',
  Status: 'project:status',
  // Main → renderer push of per-line dmcc compile logs (devkit `onLog`).
  // Dedicated channel: `project:status` keeps its one-event-per-payload
  // contract (compileEvents), this one carries the line stream (compileLogs).
  CompileLog: 'project:compileLog',
  CaptureThumbnail: 'project:captureThumbnail',
  GetThumbnail: 'project:getThumbnail',
} as const

// ── Session runtime status ───────────────────────────────────────────────
//
// Main → renderer push of the post-compile SESSION lifecycle (spawn → running
// → crash/timeout), distinct from `ProjectChannel.Status` which only tracks
// compile outcomes. Compile succeeding tells the renderer nothing about
// whether the simulator actually booted — this channel closes that gap.

export const SessionChannel = {
  RuntimeStatus: 'session:runtimeStatus',
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

// ── Editor (main → renderer) ──────────────────────────────────────────────
//
// Drives the in-renderer Monaco editor from the main process. Used by the
// "click a console file link → open the file at line:col" pipeline: the
// embedded DevTools front-end routes a source-link click through an open-
// resource handler → Electron `devtools-open-url` on the service host → main
// maps the resource URL to a project-relative path → this event opens it in
// Monaco. Payload: `EditorOpenFilePayload`.

export const EditorChannel = {
  /** main → renderer: open `path` (project-relative POSIX) at `line`/`column`. */
  OpenFile: 'editor:openFile',
} as const

/** Payload for `editor:openFile`. `line`/`column` are 1-based for Monaco. */
export interface EditorOpenFilePayload {
  /** Project-relative POSIX path (the same key Monaco opens files by). */
  path: string
  /** 1-based line to reveal; omitted/<=0 means open without moving the cursor. */
  line?: number
  /** 1-based column to reveal; defaults to 1 when a line is given. */
  column?: number
}

// ── Project list / workspace ─────────────────────────────────────────────

export const ProjectsChannel = {
  List: 'projects:list',
  Add: 'projects:add',
  Remove: 'projects:remove',
  /** Edit an existing record's name / icon; its path stays the identity. */
  Update: 'projects:update',
  /** Merged + sanitized template catalog for the create-project dialog. */
  ListTemplates: 'projects:listTemplates',
  /** Host-supplied create-project dialog hook (returns input or null). */
  OpenCreateDialog: 'projects:openCreateDialog',
  /** Host-supplied edit-project dialog hook; `null` means no hook is configured. */
  OpenEditDialog: 'projects:openEditDialog',
  /** Server-side scaffold + register (delegates to create-project-service). */
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

// ── Window ───────────────────────────────────────────────────────────────

export const WindowChannel = {
  NavigateBack: 'window:navigateBack',
  OpenProject: 'window:openProject',
  // Renderer → main: the renderer's current top-level screen ('project' when
  // inside a project screen, 'list' on the project list / landing). The
  // renderer pushes this on every screen change, including the moment it enters
  // a project — BEFORE the open resolves — so a FAILED open (no session) still
  // leaves main's mirror = 'project'. The window-close decision reads it so
  // closing a stuck/failed project returns to the list instead of quitting.
  ScreenState: 'window:screenState',
} as const

// ── App ──────────────────────────────────────────────────────────────────

export const AppChannel = {
  GetBranding: 'app:getBranding',
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

// ── Standalone internal (app-wide) DevTools debug window ─────────────────

export const InternalDevtoolsChannel = {
  // Open (or focus, if already open) the internal debug DevTools, hosted in
  // its own dedicated window (see internal-devtools-window/index.ts).
  Open: 'internal-devtools:open',
} as const
