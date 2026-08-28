import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { CompileConfig, ProjectType } from '../../../shared/types.js'
import { DEFAULT_SCENE } from '../../../shared/constants.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('projects')

// Re-exported so main-side importers keep taking it from the module that owns
// project records, while the definition stays cross-process (shared/types.ts).
export type { ProjectType }

export interface Project {
  name: string
  path: string
  lastOpened?: string | null
  compileConfig?: CompileConfig
  /** Absent on projects added before mini-game support — treat as 'miniprogram'. */
  type?: ProjectType
  /**
   * User-supplied icon for the project card. Absent means the card falls back
   * to the first character of `name`.
   */
  iconUrl?: string
}

/**
 * The subset of a project record the user may edit after import. `path` is the
 * record's identity (it keys every other per-project store — compile config,
 * thumbnail, watcher) and is deliberately not patchable: pointing an existing
 * record at another directory is an import, not an edit.
 */
export interface ProjectPatch {
  name?: string
  /** Empty string clears the icon and restores the name-initial fallback. */
  iconUrl?: string
}

export interface ProjectPages {
  pages: string[]
  entryPagePath: string
}

export interface ProjectSettings {
  uploadWithSourceMap: boolean
}

/**
 * Merge project.config.json + project.private.config.json (private wins),
 * mirroring `dimina/fe/packages/compiler/src/env.js`'s `storeInfo`.
 */
function readProjectConfig(dirPath: string): Record<string, unknown> {
  let merged: Record<string, unknown> = {}
  for (const fileName of ['project.config.json', 'project.private.config.json']) {
    const configPath = path.join(dirPath, fileName)
    if (!fs.existsSync(configPath)) continue
    try {
      merged = { ...merged, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) }
    } catch (err) {
      log.warn(`Failed to parse ${configPath}`, err)
    }
  }
  return merged
}

/**
 * The project's display name as the project itself carries it.
 *
 * `projectname` lives in the merged config with the private file winning, and
 * is URL-encoded when it leaves ASCII — WeChat DevTools 36.6.0 writes
 * `"projectname": "%E6%BD%AE%E7%8E%A9%E6%97%8F"` and its own project list only
 * mirrors that value. ASCII names encode to themselves, so plain values that
 * were written by hand round-trip unchanged.
 *
 * Returns null when the config carries no usable name, leaving the caller to
 * fall back to the directory name.
 */
function readProjectName(dirPath: string): string | null {
  const raw = readProjectConfig(dirPath).projectname
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    // A literal '%' that isn't a valid escape — keep the author's text.
    return raw
  }
}

/**
 * Persist the display name into `project.private.config.json`, the per-
 * developer half of the project config (WeChat DevTools writes the name there
 * too, leaving the shared `project.config.json` alone).
 *
 * This is what makes the config — not our list file — the single owner of the
 * name: `addProject` re-reads it, so re-importing a directory restores the
 * user's rename instead of resetting it.
 */
function writeProjectName(dirPath: string, name: string): void {
  const configPath = path.join(dirPath, 'project.private.config.json')
  let config: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      // Refuse rather than overwrite: this file also holds the user's IDE
      // settings and compile conditions, which a blind rewrite would drop.
      throw new Error(`无法重命名：${configPath} 不是合法 JSON`)
    }
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, projectname: encodeURIComponent(name) }, null, 2),
  )
}

/**
 * Mirrors `dimina/fe/packages/compiler/src/env.js`'s `detectRuntimeType` —
 * an explicit `compileType` wins, else a mini-game is inferred from
 * game.json + game.js/.ts with no app.json present.
 */
function detectRuntimeType(dirPath: string): ProjectType {
  const compileType = readProjectConfig(dirPath).compileType
  if (compileType === 'game') return 'minigame'
  if (compileType === 'miniprogram') return 'miniprogram'
  const hasMiniProgramConfig = fs.existsSync(path.join(dirPath, 'app.json'))
  const hasMiniGameConfig = fs.existsSync(path.join(dirPath, 'game.json'))
  const hasMiniGameEntry = ['game.js', 'game.ts']
    .some((fileName) => fs.existsSync(path.join(dirPath, fileName)))
  if (!hasMiniProgramConfig && hasMiniGameConfig && hasMiniGameEntry) return 'minigame'
  return 'miniprogram'
}

function getProjectsFile(): string {
  return path.join(app.getPath('userData'), 'dimina-projects.json')
}

function load(): Project[] {
  try {
    return JSON.parse(fs.readFileSync(getProjectsFile(), 'utf-8'))
  } catch {
    return []
  }
}

function save(projects: Project[]): void {
  fs.writeFileSync(getProjectsFile(), JSON.stringify(projects, null, 2))
}

export function listProjects(): Project[] {
  return load()
}

export function validateProjectDir(dirPath: string): string | null {
  if (!dirPath) {
    return '小程序目录路径为空，请选择包含小程序源码的目录'
  }
  if (!fs.existsSync(dirPath)) {
    return `小程序目录不存在：${dirPath}`
  }
  if (detectRuntimeType(dirPath) === 'minigame') {
    if (!fs.existsSync(path.join(dirPath, 'game.json'))) {
      return '该目录缺少 game.json，请选择包含小游戏源码的目录'
    }
    return null
  }
  if (!fs.existsSync(path.join(dirPath, 'app.json'))) {
    const configPath = path.join(dirPath, 'project.config.json')
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        if (cfg.miniprogramRoot) {
          const resolvedRoot = path.resolve(dirPath, cfg.miniprogramRoot)
          return `该目录缺少 app.json，project.config.json 中指定了 miniprogramRoot: "${cfg.miniprogramRoot}"，请导入 ${resolvedRoot}`
        }
      } catch (err) {
        log.warn('Failed to parse project.config.json', err)
      }
    }
    return '该目录缺少 app.json，请选择包含小程序源码的目录'
  }
  return null
}

export function hasProject(dirPath: string): boolean {
  return load().some((p) => p.path === dirPath)
}

export function addProject(dirPath: string): Project {
  const projects = load()
  // The config is the name's owner, so re-adding a directory picks up a rename
  // the user made here rather than reverting it.
  const name = readProjectName(dirPath) ?? path.basename(dirPath)

  const type = detectRuntimeType(dirPath)
  const project: Project = { name, path: dirPath, lastOpened: null, type }
  const idx = projects.findIndex((p) => p.path === dirPath)
  if (idx >= 0) {
    projects[idx] = { ...projects[idx], name, type } as Project
  } else {
    projects.unshift(project)
  }
  save(projects)
  return project
}

export function removeProject(dirPath: string): void {
  save(load().filter((p) => p.path !== dirPath))
}

/**
 * Apply a user edit to the record at `dirPath`. Returns the updated record, or
 * `null` when no record matches — callers decide whether a missing project is
 * an error (the IPC path) or a no-op.
 *
 * A name change is written through to the project's own config (see
 * `writeProjectName`); the icon lives only in our list.
 */
export function updateProject(dirPath: string, patch: ProjectPatch): Project | null {
  const projects = load()
  const idx = projects.findIndex((p) => p.path === dirPath)
  if (idx < 0) return null

  const next: Project = { ...projects[idx] }
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('Project name cannot be empty')
    next.name = name
  }
  if (patch.iconUrl !== undefined) {
    const iconUrl = patch.iconUrl.trim()
    if (iconUrl) next.iconUrl = iconUrl
    else delete next.iconUrl
  }

  // The config write comes first and is allowed to throw: a rename that only
  // reached our list would look applied until the next re-import silently
  // reverted it. The icon has no counterpart in the project config — it is
  // ours alone — so it never touches the project directory.
  if (next.name !== projects[idx].name) writeProjectName(dirPath, next.name)

  projects[idx] = next
  save(projects)
  return next
}

export function updateLastOpened(dirPath: string): void {
  const projects = load()
  const idx = projects.findIndex((p) => p.path === dirPath)
  if (idx >= 0) {
    projects[idx] = { ...projects[idx], lastOpened: new Date().toISOString() } as Project
    save(projects)
  }
}

export function getCompileConfig(dirPath: string): CompileConfig {
  const projects = load()
  const project = projects.find((p) => p.path === dirPath)
  if (project?.compileConfig) return project.compileConfig
  // Default startPage to the project's real entry page (mirrors
  // getProjectPages: 'game' for mini-games, app.json's entryPagePath for
  // mini-programs) rather than a mini-program-only literal — the simulator
  // URL builders' own 'pages/index/index' fallback only fires when this is
  // still empty (unreadable/malformed manifest).
  return {
    startPage: getProjectPages(dirPath).entryPagePath,
    scene: DEFAULT_SCENE,
    queryParams: [],
  }
}

export function getProjectPages(dirPath: string): ProjectPages {
  if (detectRuntimeType(dirPath) === 'minigame') {
    // Mini-games have no page router — the compiler always emits a single
    // synthetic 'game' entry (dimina/fe/packages/compiler/src/env.js
    // storeAppConfig), mirrored here rather than reading a nonexistent app.json.
    return { pages: ['game'], entryPagePath: 'game' }
  }
  const appJsonPath = path.join(dirPath, 'app.json')
  try {
    const appJson = JSON.parse(
      fs.readFileSync(appJsonPath, 'utf-8'),
    ) as { pages?: string[]; entryPagePath?: string }
    return {
      pages: appJson.pages || [],
      entryPagePath: appJson.entryPagePath || appJson.pages?.[0] || '',
    }
  } catch (err) {
    log.warn(`Failed to read project pages from ${appJsonPath}`, err)
    return { pages: [], entryPagePath: '' }
  }
}

export function saveCompileConfig(
  dirPath: string,
  config: CompileConfig
): void {
  const projects = load()
  const idx = projects.findIndex((p) => p.path === dirPath)
  if (idx >= 0) {
    projects[idx] = { ...projects[idx], compileConfig: config } as Project
    save(projects)
  }
}

/** Read a subset of `project.config.json` exposed to the settings panel. */
export function getProjectSettings(projectPath: string): ProjectSettings {
  if (!projectPath) {
    return { uploadWithSourceMap: false }
  }
  try {
    const configPath = path.join(projectPath, 'project.config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      setting?: { uploadWithSourceMap?: boolean }
    }
    return {
      uploadWithSourceMap: !!config.setting?.uploadWithSourceMap,
    }
  } catch {
    return { uploadWithSourceMap: false }
  }
}

/** Persist a partial patch into the `setting` block of `project.config.json`. */
export function updateProjectSettings(
  projectPath: string,
  patch: Partial<ProjectSettings>
): void {
  if (!projectPath) return
  const configPath = path.join(projectPath, 'project.config.json')
  let config: Record<string, unknown> & {
    setting?: Record<string, unknown>
  } = {}
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as typeof config
  } catch {
    // ignore and create a minimal config below
  }

  const nextSetting = {
    ...(config.setting ?? {}),
    ...(patch.uploadWithSourceMap === undefined
      ? {}
      : { uploadWithSourceMap: patch.uploadWithSourceMap }),
  }

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, setting: nextSetting }, null, 2)
  )
}
