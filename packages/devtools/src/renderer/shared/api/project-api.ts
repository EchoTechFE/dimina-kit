import type { CompileConfig, Project } from '@/shared/types'
import type { CustomCreateProjectDialogResult } from '../../../shared/types'
import type { ProjectCreateDefaults } from '../../../shared/ipc-channels'
import { ProjectsChannel, DialogChannel, ProjectChannel } from '../../../shared/ipc-channels'
import { invoke, invokeStrict, on } from './ipc-transport'

export interface AppInfo {
  appId: string
}

export type ProjectOpenResult =
  | { success: true; appInfo: AppInfo; port: number }
  | { success: false; error: string }

export interface ProjectPagesResult {
  pages: string[]
  entryPagePath?: string
}

export interface ProjectStatus {
  status: string
  message: string
  /** True when the rebuild was triggered by the file watcher — the simulator should reload. */
  hotReload?: boolean
}

/**
 * One per-line dmcc compile-log entry pushed by the main process on
 * `project:compileLog` (see `RendererNotifier.compileLog`). `at` is the
 * main-process capture timestamp.
 */
export interface CompileLogEntry {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
  /**
   * Optional shared monotonic arrival counter spanning compile EVENTS and
   * LOGS. `at` is a millisecond stamp, so a status event and the log lines
   * of the same compile routinely collide on the same `at` — the panel uses
   * `seq` as the same-`at` tie-break so the merged timeline keeps true
   * arrival order.
   */
  seq?: number
}

/** Enumerate all known projects from the workspace store. */
export function listProjects(): Promise<Project[]> {
  return invokeStrict<Project[]>(ProjectsChannel.List)
}

/** Prompt the user for a directory and return the chosen absolute path. */
export function chooseProjectDirectory(): Promise<string | null> {
  return invoke<string | null>(DialogChannel.OpenDirectory)
}

/** Register a new project rooted at `dirPath` in the workspace store. */
export function addProject(dirPath: string): Promise<Project> {
  return invokeStrict<Project>(ProjectsChannel.Add, dirPath)
}

/** Remove a project (by its root path) from the workspace store. */
export function removeProject(projectPath: string): Promise<void> {
  return invoke<void>(ProjectsChannel.Remove, projectPath)
}

/** Start a compile session for the given project. */
export function openProject(projectPath: string): Promise<ProjectOpenResult> {
  return invokeStrict<ProjectOpenResult>(ProjectChannel.Open, projectPath)
}

/** Tear down the active compile session. */
export function closeProject(): Promise<void> {
  return invoke<void>(ProjectChannel.Close)
}

/** Read the list of pages (plus the entry page) compiled for the project. */
export function getProjectPages(projectPath: string): Promise<ProjectPagesResult> {
  return invokeStrict<ProjectPagesResult>(ProjectChannel.GetPages, projectPath)
}

/** Read the persisted compile config for the given project. */
export function getCompileConfig(projectPath: string): Promise<CompileConfig> {
  return invokeStrict<CompileConfig>(ProjectChannel.GetCompileConfig, projectPath)
}

/** Persist an updated compile config for the given project. */
export function saveCompileConfig(
  projectPath: string,
  config: CompileConfig,
): Promise<void> {
  return invokeStrict<void>(ProjectChannel.SaveCompileConfig, projectPath, config)
}

/**
 * Subscribe to compile-status broadcasts from the main process. Returns an
 * unsubscribe function matching the removeListener contract.
 */
export function onProjectStatus(
  handler: (status: ProjectStatus) => void,
): () => void {
  return on<[ProjectStatus]>(ProjectChannel.Status, (status) => handler(status))
}

/**
 * Subscribe to per-line compile-log pushes from the main process (mirrors
 * `onProjectStatus`). Returns the transport unsubscribe function.
 */
export function onCompileLog(
  handler: (entry: CompileLogEntry) => void,
): () => void {
  return on<[CompileLogEntry]>(ProjectChannel.CompileLog, (entry) => handler(entry))
}

/** Capture a screenshot of the simulator and save it as a thumbnail. */
export function captureThumbnail(projectPath: string): Promise<string | null> {
  return invoke<string | null>(ProjectChannel.CaptureThumbnail, projectPath)
}

/** Load a previously saved thumbnail for the given project. */
export function getThumbnail(projectPath: string): Promise<string | null> {
  return invoke<string | null>(ProjectChannel.GetThumbnail, projectPath)
}

// ── create-project IPC wrappers ─────────────────────────────────────────

/**
 * Wire-level shape sent over IPC. Mirrors `ProjectTemplate` from the main
 * process minus the (non-serialisable) `generate` function, which is
 * stripped by `sanitizeTemplates` at the IPC boundary.
 */
export interface ProjectTemplateInfo {
  id: string
  name: string
  description?: string
  icon?: string
  source?: { type: 'directory'; path: string }
}

export interface CreateProjectInput {
  name: string
  path: string
  templateId?: string
  extra?: Record<string, unknown>
}

/** List the merged + sanitized template catalog for the create-project dialog. */
export function listTemplates(): Promise<ProjectTemplateInfo[]> {
  return invokeStrict<ProjectTemplateInfo[]>(ProjectsChannel.ListTemplates)
}

/**
 * Ask main to open the host-supplied "新建项目" dialog hook. Resolves to:
 *  - `null` — no hook configured or user cancelled; renderer should show the built-in dialog.
 *  - `{ ready }` — host has already created the project; devtools just refreshes the list.
 *  - `CreateProjectInput` — host collected inputs; devtools materialises the template locally.
 */
export function openCreateProjectDialog(): Promise<CustomCreateProjectDialogResult> {
  return invoke<CustomCreateProjectDialogResult>(ProjectsChannel.OpenCreateDialog)
}

/** Scaffold and register a new project. Returns the created Project. */
export function createProject(input: CreateProjectInput): Promise<Project> {
  return invokeStrict<Project>(ProjectsChannel.Create, input)
}

/**
 * Get the parent-directory baseline used to pre-fill the new-project dialog.
 * Resolves to a persisted "last used" base (after the first successful
 * create) or a platform default (Documents/home) for the first run.
 */
export function getCreateProjectDefaults(): Promise<ProjectCreateDefaults> {
  return invokeStrict<ProjectCreateDefaults>(ProjectsChannel.GetCreateDefaults)
}
