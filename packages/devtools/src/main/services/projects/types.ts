/**
 * Public extensibility surface for the project list panel. Hosts that embed
 * dimina-devtools (downstream hosts) can inject implementations of these types via
 * `WorkbenchAppConfig` to fully take over the project source-of-truth, the
 * template catalog, and the "新建项目" dialog.
 */

import type { CompileConfig, CompileModes } from '../../../shared/types.js'
import { DEFAULT_SCENE } from '../../../shared/constants.js'
import type { Project, ProjectPatch } from './project-repository.js'

export type { Project, ProjectPatch }
export type { ProjectTemplate, CreateProjectInput } from '../../../shared/types.js'

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
   * Apply a user edit (name / icon) to an existing record. `dirPath` is the
   * record's identity, so it is never part of the patch — see `ProjectPatch`.
   *
   * Default when omitted: throws, and the renderer shows that error in the
   * edit dialog. A silent no-op would report success (dialog closes, list
   * reloads) while discarding the user's input, since the caller has no way
   * to tell "saved" apart from "provider doesn't support this". Implement
   * this if your UI exposes the project-edit dialog.
   */
  updateProject?(dirPath: string, patch: ProjectPatch): Project | Promise<Project>

  /**
   * Record that the user just opened a project (drives "recent" ordering).
   *
   * Default when omitted: silently no-ops. The renderer's "recent" sort
   * order will then reflect whatever the provider's `listProjects` returns.
   */
  updateLastOpened?(dirPath: string): void | Promise<void>

  /**
   * Read the per-project compile config — the launch parameters the
   * SELECTED compile mode resolves to.
   *
   * Default when omitted: derived from `getCompileModes`, or
   * `DEFAULT_COMPILE_CONFIG` (`{ startPage: '', scene: 1001, queryParams: [] }`)
   * when that is absent too. Implement this only if you can resolve the
   * project's own entry page for 普通编译 — the derived default leaves
   * `startPage` empty and lets the renderer substitute it.
   */
  getCompileConfig?(dirPath: string): CompileConfig | Promise<CompileConfig>

  /**
   * @deprecated Implement `saveCompileModes` instead — the named mode list
   * is the stored form, and this setter can only express the selected
   * mode's parameters.
   *
   * Default when omitted: silently no-ops.
   */
  saveCompileConfig?(dirPath: string, cfg: CompileConfig): void | Promise<void>

  /**
   * Read the project's compile modes and which one is selected. The stored
   * form behind the toolbar's compile-mode dropdown; `LocalProjectsProvider`
   * keeps it in the project's own `project.config.json` under
   * `condition.miniprogram` (WeChat DevTools' location and shape).
   *
   * Default when omitted: `{ current: -1, list: [] }` — the dropdown then
   * offers 普通编译 only.
   */
  getCompileModes?(dirPath: string): CompileModes | Promise<CompileModes>

  /**
   * Persist the project's compile modes and selection.
   *
   * Default when omitted: falls back to `saveCompileConfig` with the
   * resolved launch parameters, so a host on the older setter keeps the
   * selection's effect but not the named list. With neither, edits do not
   * survive a reload.
   */
  saveCompileModes?(dirPath: string, modes: CompileModes): void | Promise<void>

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

/** Built-in template policy. */
export type BuiltinTemplatesMode = 'all' | 'none' | readonly string[]
