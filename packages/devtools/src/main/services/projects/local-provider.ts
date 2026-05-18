/**
 * Default ProjectsProvider — persists the project list to
 * `<userData>/dimina-projects.json` and exposes the validation / compile-
 * config helpers historically provided by `project-repository.ts`.
 *
 * The repository module is kept for thumbnail/paths/page helpers and for
 * back-compat re-exports; the canonical list & validation surface for the
 * workspace service is this provider.
 */
import * as repo from './project-repository.js'
import { loadThumbnail, saveThumbnailFromDataUrl } from './thumbnail.js'
import type { ProjectsProvider } from './types.js'

export function createLocalProjectsProvider(): ProjectsProvider {
  return {
    listProjects: () => repo.listProjects(),
    addProject: (dirPath) => repo.addProject(dirPath),
    removeProject: (dirPath) => repo.removeProject(dirPath),
    validateProjectDir: (dirPath) => repo.validateProjectDir(dirPath),
    updateLastOpened: (dirPath) => repo.updateLastOpened(dirPath),
    getCompileConfig: (dirPath) => repo.getCompileConfig(dirPath),
    saveCompileConfig: (dirPath, cfg) => repo.saveCompileConfig(dirPath, cfg),
    saveThumbnail: (dirPath, dataUrl) =>
      saveThumbnailFromDataUrl(dirPath, dataUrl),
    getThumbnail: (dirPath) => loadThumbnail(dirPath),
  }
}
