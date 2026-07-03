/**
 * Pure DevTools-resource-URL → project-relative-path resolution for the
 * "open in editor" pipeline.
 *
 * Every function here is `.toString()`-injected verbatim into the DevTools
 * front-end realm by `buildDevtoolsProjectSourceLinksScript` (in
 * `open-in-editor.ts`), alongside being called directly from the main process.
 * That constrains each function to be self-contained (no closures over
 * module-level state beyond calling the OTHER functions in this file, which
 * the injection site also stringifies into the same scope) — no electron / DOM
 * / node deps.
 */

export interface ProjectSourceContext {
  /** Absolute project root on disk. */
  projectRoot: string
  /** Resource server base URL used by the compiled miniapp. */
  resourceBaseUrl: string
  appId: string
  /** Compiler output package root (`main` for the primary package). */
  outputRoot: string
}

export function decodePathname(pathname: string): string {
  return pathname.split('/').map((segment) => {
    try { return decodeURIComponent(segment) } catch { return segment }
  }).join('/')
}

export function normalizeSlashPath(value: string): string {
  return decodePathname(value.replace(/\\/g, '/')).replace(/\/+/g, '/')
}

export function safeRelativePath(segments: string[]): string | null {
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null
  }
  return segments.join('/')
}

/**
 * Taro/webpack build + runtime chunks are compiled output, not hand-written
 * source. They also collide: dimina's own service runtime attributes its
 * `log()` helper to a `common.js` on the SAME dev-server origin as the
 * project's compiled `common.js` chunk, so the two are URL-indistinguishable
 * and a dimina-core frame would otherwise open the project's chunk. Drop these
 * well-known chunk basenames so a click falls through to the DevTools Sources
 * panel instead of opening the wrong (or generated) file.
 */
export function excludeBuildChunk(rel: string | null): string | null {
  if (!rel) return rel
  const baseName = rel.split('/').pop()
  return baseName === 'common.js' || baseName === 'vendors.js' || baseName === 'runtime.js'
    || baseName === 'taro.js' || baseName === 'babelHelpers.js'
    ? null
    : rel
}

/**
 * Real host filesystem paths use well-known absolute roots; when they are
 * outside the active project they are runtime/devtools frames, not sources.
 */
export function isOutsideKnownRoot(normalizedRaw: string): boolean {
  return /^\/(?:Volumes|Users|home|private|tmp|var|opt|Applications)\//.test(normalizedRaw)
}

/**
 * Chromium may hand the open-resource hook a raw absolute filesystem path
 * (already project-rooted). Returns `undefined` (not `null`) when the raw
 * value is not under `projectRoot` at all, so the caller can distinguish "not
 * this shape" from "matched, but excluded as a build chunk" (`null`).
 */
export function resolveFilesystemRawPath(normalizedRaw: string, projectRoot: string): string | null | undefined {
  if (!projectRoot) return undefined
  if (normalizedRaw !== projectRoot && !normalizedRaw.startsWith(`${projectRoot}/`)) return undefined
  const relative = normalizedRaw.slice(projectRoot.length).replace(/^\/+/, '')
  return excludeBuildChunk(safeRelativePath(relative.split('/').filter(Boolean)))
}

export function parseResourceUrl(raw: string, base: URL): URL | null {
  try {
    return raw.startsWith('/') && !raw.startsWith('//') ? new URL(raw, base.origin) : new URL(raw)
  } catch {
    return null
  }
}

export function resolveFileProtocolPath(resource: URL, projectRoot: string): string | null {
  const filePath = normalizeSlashPath(resource.pathname)
  if (!projectRoot || (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}/`))) return null
  return excludeBuildChunk(safeRelativePath(
    filePath.slice(projectRoot.length).replace(/^\/+/, '').split('/').filter(Boolean),
  ))
}

export function resolveHttpProtocolPath(resource: URL, base: URL, context: ProjectSourceContext): string | null {
  if (resource.protocol !== 'http:' && resource.protocol !== 'https:') return null
  if (resource.origin !== base.origin) return null
  let segments = decodePathname(resource.pathname).split('/').filter(Boolean)
  if (context.appId && segments[0] === context.appId) {
    segments = segments.slice(1)
    if (context.outputRoot && segments[0] === context.outputRoot) segments = segments.slice(1)
  }
  return excludeBuildChunk(safeRelativePath(segments))
}

/**
 * Map a resource URL/path to a project-relative POSIX path, or null when it is
 * not a mappable project source (framework frame, different origin, escapes
 * the project root, or an excluded build chunk).
 */
export function projectAwareResourcePath(resourceUrl: string, context: ProjectSourceContext): string | null {
  let base: URL
  try {
    base = new URL(context.resourceBaseUrl)
  } catch {
    return null
  }

  const projectRoot = normalizeSlashPath(context.projectRoot).replace(/\/$/, '')
  const raw = resourceUrl.trim()
  if (!raw) return null

  const normalizedRaw = normalizeSlashPath(raw)
  const filesystemRelative = resolveFilesystemRawPath(normalizedRaw, projectRoot)
  if (filesystemRelative !== undefined) return filesystemRelative
  if (isOutsideKnownRoot(normalizedRaw)) return null

  // Reject relative runtime labels such as `service.js` or
  // `electron/js2c/renderer_init`; project source locations must be an
  // absolute URL/path so they can be scoped to the active project.
  if (!raw.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null

  const resource = parseResourceUrl(raw, base)
  if (!resource) return null

  if (resource.protocol === 'file:') return resolveFileProtocolPath(resource, projectRoot)
  return resolveHttpProtocolPath(resource, base, context)
}
