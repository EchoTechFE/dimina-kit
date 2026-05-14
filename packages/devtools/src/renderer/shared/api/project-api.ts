import type { CompileConfig, Project } from '@/shared/types'
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
