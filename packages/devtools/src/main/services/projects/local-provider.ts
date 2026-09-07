/**
 * Default ProjectsProvider — persists the project list to
 * `<userData>/dimina-projects.json` and exposes the validation / compile-
 * config helpers historically provided by `project-repository.ts`.
 *
 * The repository module is kept for thumbnail/paths/page helpers; the
 * canonical list & validation surface for the workspace service is this
 * provider.
 */
import * as repo from './project-repository.js'
import { loadThumbnail, saveThumbnailFromDataUrl } from './thumbnail.js'
import type { ProjectsProvider } from './types.js'

export function createLocalProjectsProvider(): ProjectsProvider {
  return {
    listProjects: () => repo.listProjects(),
    addProject: (dirPath) => repo.addProject(dirPath),
    removeProject: (dirPath) => repo.removeProject(dirPath),
    updateProject: (dirPath, patch) => {
      const updated = repo.updateProject(dirPath, patch)
      if (!updated) throw new Error(`No such project: ${dirPath}`)
      return updated
    },
    validateProjectDir: (dirPath) => repo.validateProjectDir(dirPath),
    updateLastOpened: (dirPath) => repo.updateLastOpened(dirPath),
    getCompileConfig: (dirPath) => repo.getCompileConfig(dirPath),
    saveCompileConfig: (dirPath, cfg) => repo.saveCompileConfig(dirPath, cfg),
    getCompileModes: (dirPath) => repo.getCompileModes(dirPath),
    saveCompileModes: (dirPath, modes) => repo.saveCompileModes(dirPath, modes),
    saveThumbnail: (dirPath, dataUrl) =>
      saveThumbnailFromDataUrl(dirPath, dataUrl),
    getThumbnail: (dirPath) => loadThumbnail(dirPath),
  }
}
