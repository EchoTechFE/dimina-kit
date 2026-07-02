import fs from 'node:fs'
import path from 'path'
import {
  type OpenInEditorRequest,
  projectSourceContextFromServiceHostUrl,
  resourceUrlToProjectRelativePath,
} from '../../../shared/open-in-editor.js'

export interface ProjectEditorTarget {
  path: string
  line?: number
  column?: number
}

/**
 * Resolve a DevTools source request against the service-host URL that created
 * the inspected app. Its pkgRoot is authoritative; the workspace is only a
 * stale-session consistency guard.
 */
export function resolveProjectEditorTarget(
  serviceHostUrl: string,
  activeProjectRoot: string | undefined,
  req: OpenInEditorRequest,
  isFile: (absolutePath: string) => boolean = (absolutePath) => fs.statSync(absolutePath).isFile(),
): ProjectEditorTarget | null {
  const sourceContext = projectSourceContextFromServiceHostUrl(
    serviceHostUrl,
    activeProjectRoot,
  )
  if (!sourceContext) return null
  const rel = resourceUrlToProjectRelativePath(req.url, sourceContext)
  if (!rel) return null
  const absolute = path.resolve(sourceContext.projectRoot, ...rel.split('/'))
  const fromRoot = path.relative(path.resolve(sourceContext.projectRoot), absolute)
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return null
  try {
    if (!isFile(absolute)) return null
  } catch {
    return null
  }
  return {
    path: rel,
    line: typeof req.line === 'number' ? req.line + 1 : undefined,
    column: typeof req.column === 'number' ? req.column + 1 : undefined,
  }
}
