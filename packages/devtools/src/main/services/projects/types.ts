/**
 * Public extensibility surface for the project list panel. Hosts that embed
 * dimina-devtools (e.g. qdmp) can inject implementations of these types via
 * `WorkbenchAppConfig` to fully take over the project source-of-truth, the
 * template catalog, and the "新建项目" dialog.
 */

import type { CompileConfig } from '../../../shared/types.js'
import { DEFAULT_SCENE } from '../../../shared/constants.js'
import type { Project } from './project-repository.js'

export type { Project }

/**
 * Default compile config returned by WorkspaceService when the injected
 * provider omits `getCompileConfig`, or when no record exists for a path.
 * Exported so host providers can mirror the canonical shape instead of
 * re-deriving the magic values.
 */
export const DEFAULT_COMPILE_CONFIG: CompileConfig = {
  startPage: '',
  scene: DEFAULT_SCENE,
  queryParams: [],
}

/**
 * Pluggable project-list backend. The default implementation
 * (LocalProjectsProvider) persists to `<userData>/dimina-projects.json`.
 *
 * All methods may return synchronously OR as a Promise.
 *
 * Optional methods documented per field below; when the host omits an
 * optional method, WorkspaceService applies a documented default
 * (typically a safe no-op) — it does NOT silently fall back to the local
 * file-system helpers, since for a remote provider the project path may
 * not exist on this machine at all.
 */
export interface ProjectsProvider {
  listProjects(): Project[] | Promise<Project[]>

  /**
   * Validate that `dirPath` points at a mini-app source tree.
   * Return `null` if valid, or a user-facing error message string.
   *
   * Default when omitted: returns `null` (no validation). Remote
   * providers SHOULD implement this if the host UI exposes "import an
   * existing directory"; otherwise the user can add unreachable paths.
   */
  validateProjectDir?(dirPath: string): string | null | Promise<string | null>

  addProject(dirPath: string): Project | Promise<Project>
  removeProject(dirPath: string): void | Promise<void>

  /**
   * Record that the user just opened a project (drives "recent" ordering).
   *
   * Default when omitted: silently no-ops. The renderer's "recent" sort
   * order will then reflect whatever the provider's `listProjects` returns.
   */
  updateLastOpened?(dirPath: string): void | Promise<void>

  /**
   * Read the per-project compile config.
   *
   * Default when omitted: returns `DEFAULT_COMPILE_CONFIG`
   * (`{ startPage: '', scene: 1001, queryParams: [] }`).
   */
  getCompileConfig?(dirPath: string): CompileConfig | Promise<CompileConfig>

  /**
   * Persist the per-project compile config.
   *
   * Default when omitted: silently no-ops — the renderer's edits will
   * not survive a reload. Implement this if your UI exposes the compile
   * config panel.
   */
  saveCompileConfig?(dirPath: string, cfg: CompileConfig): void | Promise<void>

  /**
   * Persist a captured screenshot for the given project. `imageDataUrl`
   * is a `data:image/png;base64,...` string so a remote provider can ship
   * it straight to its backend without re-encoding.
   *
   * Default when omitted: silently no-ops (the screenshot is dropped).
   * Implement this for hosts whose projects don't live on the local
   * filesystem and that want thumbnails to round-trip through their own
   * storage.
   */
  saveThumbnail?(dirPath: string, imageDataUrl: string): void | Promise<void>

  /**
   * Load the most recently saved thumbnail for the given project.
   * Returns a `data:image/png;base64,...` string or `null` when there
   * is none.
   *
   * Default when omitted: returns `null`.
   */
  getThumbnail?(dirPath: string): string | null | Promise<string | null>
}

/**
 * A template the user can pick from in the "新建项目" dialog. Exactly one of
 * `source` or `generate` should be supplied; if both are omitted, the
 * service refuses to materialise the template.
 */
export interface ProjectTemplate {
  /** Stable identifier. Used by host whitelists and the `templateId` field of CreateProjectInput. */
  id: string
  /** Human-readable label shown in the dialog. */
  name: string
  description?: string
  icon?: string
  /** Copy-tree source. `path` must be absolute. */
  source?: { type: 'directory'; path: string }
  /** Programmatic generator. `target` is the absolute destination directory. */
  generate?: (target: string, opts: { name: string }) => Promise<void>
}

/**
 * Payload returned from the create-project dialog. The service uses this to
 * scaffold disk content and to register the project with the provider.
 */
export interface CreateProjectInput {
  name: string
  path: string
  templateId?: string
  extra?: Record<string, unknown>
}

/** Built-in template policy. */
export type BuiltinTemplatesMode = 'all' | 'none' | readonly string[]
