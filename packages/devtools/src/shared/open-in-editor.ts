/**
 * Shared, pure helpers for the "click a console file link → open the built-in
 * Monaco editor" pipeline (native-host).
 *
 * The right-panel console is the embedded Chromium DevTools front-end inspecting
 * the service host. When a sourcemap maps a console frame back to source, the
 * front-end can be made to route a source-link click through an "open resource
 * handler" instead of its own Sources panel (the same hook IDEs use to integrate
 * with Chrome DevTools). Our handler can't talk IPC directly from the closed
 * DevTools realm, so it encodes the target as a sentinel URL and asks the
 * front-end to "open" it; Electron surfaces that as a `devtools-open-url` event
 * on the inspected webContents, which main decodes here.
 *
 * This module owns ONLY the pure string/URL logic (encode + decode + map a
 * DevTools resource URL to a project-relative path). It has no electron / DOM /
 * node deps so it is unit-testable and shared by main + the injected front-end
 * snippet's expectations.
 */

/**
 * Sentinel scheme for the encoded "open in editor" request. A bare custom scheme
 * (no `//authority`) keeps the encoded payload entirely in the URL's path/query,
 * which `InspectorFrontendHost.openInNewTab` forwards verbatim to Electron's
 * `devtools-open-url` event.
 */
export const OPEN_IN_EDITOR_SCHEME = 'dimina-open-in-editor'

/** A decoded open-in-editor request: a project source location. */
export interface OpenInEditorRequest {
  /** The DevTools resource URL of the clicked source (the map `sources` entry, absolute). */
  url: string
  /** 0-based line as reported by DevTools (may be undefined for a bare file link). */
  line?: number
  /** 0-based column as reported by DevTools (may be undefined). */
  column?: number
}

export interface ProjectSourceContext {
  /** Absolute project root on disk. */
  projectRoot: string
  /** Resource server base URL used by the compiled miniapp. */
  resourceBaseUrl: string
  appId: string
  /** Compiler output package root (`main` for the primary package). */
  outputRoot: string
}

/**
 * Encode an open-in-editor request as a sentinel URL the DevTools front-end can
 * hand to `InspectorFrontendHost.openInNewTab(...)`. All fields ride in the
 * query string so no value is ever interpolated into a path segment.
 */
export function encodeOpenInEditorUrl(req: OpenInEditorRequest): string {
  const params = new URLSearchParams()
  params.set('u', req.url)
  if (typeof req.line === 'number' && Number.isFinite(req.line)) {
    params.set('l', String(Math.trunc(req.line)))
  }
  if (typeof req.column === 'number' && Number.isFinite(req.column)) {
    params.set('c', String(Math.trunc(req.column)))
  }
  return `${OPEN_IN_EDITOR_SCHEME}:?${params.toString()}`
}

/**
 * Decode a sentinel URL produced by `encodeOpenInEditorUrl`. Returns null for
 * any URL that is not our sentinel scheme (so a real "open in new tab" link the
 * user clicked is left to Electron's default external-open path).
 */
export function decodeOpenInEditorUrl(raw: string): OpenInEditorRequest | null {
  if (typeof raw !== 'string') return null
  const prefix = `${OPEN_IN_EDITOR_SCHEME}:`
  if (!raw.startsWith(prefix)) return null
  // Strip the scheme; tolerate an optional leading `?` on the query.
  let query = raw.slice(prefix.length)
  if (query.startsWith('?')) query = query.slice(1)
  const params = new URLSearchParams(query)
  const url = params.get('u')
  if (!url) return null
  const out: OpenInEditorRequest = { url }
  const l = params.get('l')
  const c = params.get('c')
  if (l !== null && l !== '') {
    const n = Number(l)
    if (Number.isFinite(n)) out.line = Math.trunc(n)
  }
  if (c !== null && c !== '') {
    const n = Number(c)
    if (Number.isFinite(n)) out.column = Math.trunc(n)
  }
  return out
}

/**
 * Map a DevTools resource URL to a PROJECT-RELATIVE source path (POSIX, no
 * leading slash) — the same key the in-renderer Monaco editor opens files by
 * (`joinPosix(root, rel)` → `project:fs:readFile`).
 *
 * The compiler emits each `logic.js.map` with `sources` = the project-relative
 * source path (e.g. `pages/home/home.js`, or `subpkg/pages/x/x.js` for a sub-
 * package — both already rooted at the project). DevTools resolves those against
 * the map URL on the dev server, producing
 * `http://127.0.0.1:<port>/<appId>/<source-path>`. So recovering the project-
 * relative path is exactly: strip the origin, then strip the FIRST path segment
 * (the `<appId>` the dev server namespaces the bundle under). What remains is
 * the source path the compiler recorded, which is the editor's open key — this
 * holds for both the main package and sub-packages without needing the project's
 * appId / root threaded in.
 *
 * @param resourceUrl  The absolute URL DevTools reported for the clicked source.
 * @param expectedOrigin  Optional dev-server origin to gate on
 *   (`http://127.0.0.1:<port>`); when given, a URL from a different origin (a
 *   framework/`webpack://`/`node:` frame) returns null instead of mis-mapping.
 * @returns the project-relative POSIX path, or null when the URL is not a
 *   mappable dev-server source.
 */
export function resourceUrlToProjectRelativePath(
  resourceUrl: string,
  expectedOriginOrContext?: string | ProjectSourceContext,
): string | null {
  if (typeof resourceUrl !== 'string' || !resourceUrl) return null
  if (expectedOriginOrContext && typeof expectedOriginOrContext === 'object') {
    return projectAwareResourcePath(resourceUrl, expectedOriginOrContext)
  }
  let resource: URL
  try {
    resource = new URL(resourceUrl)
  } catch {
    return null
  }
  // Only http(s) dev-server sources map to project files; schemes like
  // `webpack://`, `node:`, `data:` are framework/runtime frames with no file.
  if (resource.protocol !== 'http:' && resource.protocol !== 'https:') return null
  if (expectedOriginOrContext) {
    let base: URL
    try { base = new URL(expectedOriginOrContext) } catch { return null }
    if (resource.origin !== base.origin) return null
  }

  // pathname is `/<appId>/<source-path>`. Drop the leading appId segment; the
  // remainder, percent-decoded per segment, is the project-relative path.
  const segments = resource.pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s) } catch { return s }
  })
  if (segments.length < 2) return null
  return segments.slice(1).join('/')
}

function decodePathname(pathname: string): string {
  return pathname.split('/').map((segment) => {
    try { return decodeURIComponent(segment) } catch { return segment }
  }).join('/')
}

function normalizeSlashPath(value: string): string {
  return decodePathname(value.replace(/\\/g, '/')).replace(/\/+/g, '/')
}

function safeRelativePath(segments: string[]): string | null {
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null
  }
  return segments.join('/')
}

function projectAwareResourcePath(resourceUrl: string, context: ProjectSourceContext): string | null {
  let base: URL
  try {
    base = new URL(context.resourceBaseUrl)
  } catch {
    return null
  }

  const projectRoot = normalizeSlashPath(context.projectRoot).replace(/\/$/, '')
  const raw = resourceUrl.trim()
  if (!raw) return null

  // Chromium may hand the open-resource hook a raw absolute filesystem path.
  const normalizedRaw = normalizeSlashPath(raw)
  if (projectRoot && (normalizedRaw === projectRoot || normalizedRaw.startsWith(`${projectRoot}/`))) {
    const relative = normalizedRaw.slice(projectRoot.length).replace(/^\/+/, '')
    return safeRelativePath(relative.split('/').filter(Boolean))
  }
  // Sourcemap sources commonly use virtual root paths such as `/pages/x.js`.
  // Real host filesystem paths use well-known absolute roots; when they are
  // outside the active project they are runtime/devtools frames, not sources.
  if (/^\/(?:Volumes|Users|home|private|tmp|var|opt|Applications)\//.test(normalizedRaw)) {
    return null
  }

  // Reject relative runtime labels such as `service.js` or
  // `electron/js2c/renderer_init`; project source locations must be an
  // absolute URL/path so they can be scoped to the active project.
  if (!raw.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null

  let resource: URL
  try {
    resource = raw.startsWith('/') && !raw.startsWith('//')
      ? new URL(raw, base.origin)
      : new URL(raw)
  } catch {
    return null
  }

  if (resource.protocol === 'file:') {
    const filePath = normalizeSlashPath(resource.pathname)
    if (!projectRoot || (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}/`))) return null
    return safeRelativePath(
      filePath.slice(projectRoot.length).replace(/^\/+/, '').split('/').filter(Boolean),
    )
  }

  if (resource.protocol !== 'http:' && resource.protocol !== 'https:') return null
  if (resource.origin !== base.origin) return null

  let segments = decodePathname(resource.pathname).split('/').filter(Boolean)
  if (context.appId && segments[0] === context.appId) {
    segments = segments.slice(1)
    if (context.outputRoot && segments[0] === context.outputRoot) segments = segments.slice(1)
  }
  return safeRelativePath(segments)
}

/** Read the project/source routing metadata carried by a service-host spawn URL. */
export function projectSourceContextFromServiceHostUrl(
  serviceHostUrl: string,
  activeProjectRoot?: string,
): ProjectSourceContext | null {
  let url: URL
  try {
    url = new URL(serviceHostUrl)
  } catch {
    return null
  }
  const projectRoot = url.searchParams.get('pkgRoot') || ''
  const resourceBaseUrl = url.searchParams.get('resourceBaseUrl') ?? ''
  const appId = url.searchParams.get('appId') ?? ''
  const outputRoot = url.searchParams.get('root') ?? 'main'
  if (!projectRoot || !resourceBaseUrl || !appId) return null
  if (activeProjectRoot) {
    const authoritativeRoot = normalizeSlashPath(projectRoot).replace(/\/+$/, '')
    const currentRoot = normalizeSlashPath(activeProjectRoot).replace(/\/+$/, '')
    if (!authoritativeRoot || authoritativeRoot !== currentRoot) return null
  }
  try {
    new URL(resourceBaseUrl)
  } catch {
    return null
  }
  return { projectRoot, resourceBaseUrl, appId, outputRoot }
}

/**
 * Build the DevTools-front-end glue for project source links.
 *
 * It keeps the existing `setOpenResourceHandler` transport, but only forwards
 * locations that map to the active project. A DOM observer expands Chromium's
 * basename-only console labels to project-relative paths.
 */
export function buildDevtoolsProjectSourceLinksScript(context: ProjectSourceContext): string {
  const config = JSON.stringify(context)
  const scheme = JSON.stringify(OPEN_IN_EDITOR_SCHEME)
  return `
    (function() {
      try {
        const stateKey = '__diminaProjectSourceLinksState__'
        const previousState = globalThis[stateKey]
        if (previousState && typeof previousState.dispose === 'function') {
          try { previousState.dispose() } catch (_) {}
        }

        const cfg = ${config}
        const diminaProjectSourcePath = ${projectAwareResourcePath.toString()}
        const decodePathname = ${decodePathname.toString()}
        const normalizeSlashPath = ${normalizeSlashPath.toString()}
        const safeRelativePath = ${safeRelativePath.toString()}
        const observedRoots = new Set()
        const observers = []
        let timer = null
        const state = {
          dispose() {
            if (timer !== null) {
              clearInterval(timer)
              timer = null
            }
            for (const observer of observers.splice(0)) {
              try { observer.disconnect() } catch (_) {}
            }
            observedRoots.clear()
          },
        }
        globalThis[stateKey] = state

        function splitLocation(value) {
          const raw = String(value || '')
          const match = raw.match(/^(.*?)(?::(\\d+))(?::(\\d+))?$/)
          return match
            ? { url: match[1], suffix: ':' + match[2] + (match[3] ? ':' + match[3] : '') }
            : { url: raw, suffix: '' }
        }

        function rewriteLink(link) {
          if (!link || link.dataset.diminaProjectSourcePath) return
          const candidates = [
            link.getAttribute && link.getAttribute('title'),
            link.getAttribute && link.getAttribute('href'),
            link.getAttribute && link.getAttribute('data-url'),
          ]
          for (const candidate of candidates) {
            if (!candidate) continue
            const location = splitLocation(candidate)
            const relative = diminaProjectSourcePath(location.url, cfg)
            if (!relative) continue
            const textSuffix = location.suffix || ((String(link.textContent || '').match(/(:\\d+(?::\\d+)?)$/) || [])[1] || '')
            link.textContent = relative + textSuffix
            link.dataset.diminaProjectSourcePath = relative
            return
          }
        }

        function observeRoot(root) {
          if (!root || !root.querySelectorAll || observedRoots.has(root)) return
          observedRoots.add(root)

          const observer = new MutationObserver((records) => {
            for (const record of records) {
              if (record.type === 'attributes') rewriteLink(record.target)
              for (const node of record.addedNodes || []) visitNode(node)
            }
          })
          observer.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['title', 'href', 'data-url'],
          })
          observers.push(observer)

          for (const link of root.querySelectorAll('.devtools-link')) rewriteLink(link)
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) observeRoot(element.shadowRoot)
          }
        }

        function visitNode(node) {
          if (!node) return
          if (node.matches && node.matches('.devtools-link')) rewriteLink(node)
          if (node.shadowRoot) observeRoot(node.shadowRoot)
          if (!node.querySelectorAll) return
          for (const link of node.querySelectorAll('.devtools-link')) rewriteLink(link)
          for (const element of node.querySelectorAll('*')) {
            if (element.shadowRoot) observeRoot(element.shadowRoot)
          }
        }

        observeRoot(document)

        let tries = 0
        timer = setInterval(() => {
          tries++
          try {
            const Host = globalThis.Host
            const host = Host && Host.InspectorFrontendHost
            if (host && typeof host.setOpenResourceHandler === 'function'
                     && typeof host.openInNewTab === 'function') {
              host.setOpenResourceHandler((url, lineNumber, columnNumber) => {
                try {
                  if (!diminaProjectSourcePath(String(url), cfg)) return
                  const p = new URLSearchParams()
                  p.set('u', String(url))
                  if (typeof lineNumber === 'number') p.set('l', String(lineNumber))
                  if (typeof columnNumber === 'number') p.set('c', String(columnNumber))
                  host.openInNewTab(${scheme} + ':?' + p.toString())
                } catch (_) {}
              })
              clearInterval(timer)
              timer = null
            }
          } catch (_) {}
          if (tries > 80 && timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }, 50)
      } catch (_) {}
    })()
  `
}
