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
  let name = path.basename(dirPath)
  try {
    const configPath = path.join(dirPath, 'project.config.json')
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (cfg.projectname) name = cfg.projectname
    }
  } catch (err) {
    log.warn('Failed to read project name from config', err)
  }

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
