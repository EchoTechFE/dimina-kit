import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { CompileConfig } from '../../../shared/types.js'
import { DEFAULT_SCENE } from '../../../shared/constants.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('projects')

export interface Project {
  name: string
  path: string
  lastOpened?: string | null
  compileConfig?: CompileConfig
}

export interface ProjectPages {
  pages: string[]
  entryPagePath: string
}

export interface ProjectSettings {
  uploadWithSourceMap: boolean
}

// Re-export CompileConfig for backward compatibility
export type { CompileConfig } from '../../../shared/types.js'

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

  const project: Project = { name, path: dirPath, lastOpened: null }
  const idx = projects.findIndex((p) => p.path === dirPath)
  if (idx >= 0) {
    projects[idx] = { ...projects[idx], name } as Project
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
  return (
    project?.compileConfig ?? {
      startPage: '',
      scene: DEFAULT_SCENE,
      queryParams: [],
    }
  )
}

export function getProjectPages(dirPath: string): ProjectPages {
  const appJsonPath = path.join(dirPath, 'app.json')
  try {
    const appJson = JSON.parse(
      fs.readFileSync(appJsonPath, 'utf-8'),
    ) as { pages?: string[]; entryPagePath?: string }
    return {
      pages: appJson.pages || [],
      entryPagePath: appJson.entryPagePath || appJson.pages?.[0] || '',
    }
  } catch {
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
