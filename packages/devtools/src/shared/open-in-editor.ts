/**
 * Shared, pure helpers for the "click a console file link → open the editor"
 * pipeline (native-host).
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

import {
  decodePathname,
  excludeBuildChunk,
  isOutsideKnownRoot,
  normalizeSlashPath,
  parseResourceUrl,
  type ProjectSourceContext,
  projectAwareResourcePath,
  resolveFileProtocolPath,
  resolveFilesystemRawPath,
  resolveHttpProtocolPath,
  safeRelativePath,
} from './open-in-editor-resource-path.js'

export type { ProjectSourceContext } from './open-in-editor-resource-path.js'

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
 * leading slash) — the key the workbench opens files by (mirrored under
 * `file:///workspace/<rel>`).
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
 * Primary transport is a capture-phase click interceptor: a project-source link
 * click is redirected to `InspectorFrontendHost.openInNewTab(<sentinel>)` (which
 * Electron surfaces as `devtools-open-url` on the inspected wc) and the default
 * DevTools Sources reveal is suppressed. This survives current Chromium DevTools,
 * where the legacy `Host.InspectorFrontendHost.setOpenResourceHandler` hook is
 * gone (the host moved to the top-level `InspectorFrontendHost` global and that
 * method no longer exists). The `setOpenResourceHandler` registration below is
 * kept as a no-op-when-absent fallback for older fronts. Only locations that map
 * to the active project are forwarded; a DOM observer expands Chromium's
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
        const decodePathname = ${decodePathname.toString()}
        const normalizeSlashPath = ${normalizeSlashPath.toString()}
        const safeRelativePath = ${safeRelativePath.toString()}
        const excludeBuildChunk = ${excludeBuildChunk.toString()}
        const isOutsideKnownRoot = ${isOutsideKnownRoot.toString()}
        const resolveFilesystemRawPath = ${resolveFilesystemRawPath.toString()}
        const parseResourceUrl = ${parseResourceUrl.toString()}
        const resolveFileProtocolPath = ${resolveFileProtocolPath.toString()}
        const resolveHttpProtocolPath = ${resolveHttpProtocolPath.toString()}
        const diminaProjectSourcePath = ${projectAwareResourcePath.toString()}
        const observedRoots = new Set()
        const observers = []
        const clickBindings = []
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
            for (const binding of clickBindings.splice(0)) {
              try { binding.target.removeEventListener('click', binding.fn, true) } catch (_) {}
            }
            observedRoots.clear()
          },
        }
        globalThis[stateKey] = state

        // The InspectorFrontendHost that owns openInNewTab. Across DevTools
        // versions it lives on the top-level \`InspectorFrontendHost\` global, the
        // legacy \`Host.InspectorFrontendHost\`, or \`DevToolsHost\`; resolve at call
        // time so a late-bootstrapped host is still found.
        function resolveOpenInNewTabHost() {
          const candidates = [
            globalThis.InspectorFrontendHost,
            globalThis.Host && globalThis.Host.InspectorFrontendHost,
            globalThis.DevToolsHost,
          ]
          for (const host of candidates) {
            if (host && typeof host.openInNewTab === 'function') return host
          }
          return null
        }

        // Encode (url, 0-based line, 0-based column) as the sentinel the main
        // process decodes from \`devtools-open-url\` and routes to Monaco.
        function openInEditor(url, line, column) {
          const host = resolveOpenInNewTabHost()
          if (!host) return false
          const p = new URLSearchParams()
          p.set('u', String(url))
          if (typeof line === 'number' && isFinite(line)) p.set('l', String(line))
          if (typeof column === 'number' && isFinite(column)) p.set('c', String(column))
          try { host.openInNewTab(${scheme} + ':?' + p.toString()) } catch (_) { return false }
          return true
        }

        // Resolve a clicked link element to a project source location. Returns
        // the FULL resource url (the main process re-maps it against the active
        // project) plus its display line/column when present.
        function projectLocationForLink(link) {
          if (!link) return null
          const candidates = [
            link.getAttribute && link.getAttribute('data-url'),
            link.getAttribute && link.getAttribute('href'),
            link.getAttribute && link.getAttribute('title'),
          ]
          for (const candidate of candidates) {
            if (!candidate) continue
            const location = splitLocation(candidate)
            if (!diminaProjectSourcePath(location.url, cfg)) continue
            const suffix = location.suffix
              || ((String(link.textContent || '').match(/(:\\d+(?::\\d+)?)$/) || [])[1] || '')
            return { url: location.url, suffix }
          }
          return null
        }

        // DevTools shows 1-based line:column in link text; the main process
        // contract expects 0-based (it re-adds 1). Convert here.
        function parseSuffix(suffix) {
          const m = String(suffix || '').match(/^:(\\d+)(?::(\\d+))?$/)
          if (!m) return { line: undefined, column: undefined }
          const line = Math.max(0, parseInt(m[1], 10) - 1)
          const column = m[2] != null ? Math.max(0, parseInt(m[2], 10) - 1) : undefined
          return { line, column }
        }

        // Capture-phase click handler: route a project-source link click to
        // Monaco instead of the DevTools Sources panel. Plain primary clicks only
        // — modified clicks (cmd/ctrl/shift/alt, middle button) fall through to
        // DevTools so its own "open in new tab" / multi-select still work.
        function onLinkClick(event) {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          const path = typeof event.composedPath === 'function' ? event.composedPath() : []
          let link = null
          for (const node of path) {
            if (node && node.nodeType === 1 && node.classList && node.classList.contains('devtools-link')) {
              link = node
              break
            }
          }
          if (!link) return
          const location = projectLocationForLink(link)
          if (!location) return
          const { line, column } = parseSuffix(location.suffix)
          if (!openInEditor(location.url, line, column)) return
          event.preventDefault()
          event.stopImmediatePropagation()
        }

        function bindClicks(target) {
          if (!target || !target.addEventListener) return
          for (const binding of clickBindings) {
            if (binding.target === target) return
          }
          target.addEventListener('click', onLinkClick, true)
          clickBindings.push({ target, fn: onLinkClick })
        }

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
          bindClicks(root)

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

        // Fallback for older DevTools fronts that still expose the
        // setOpenResourceHandler hook. On current Chromium the method is gone,
        // so this poll simply times out and the capture-phase click interceptor
        // is the only live path. When the hook IS present the interceptor still
        // wins (it runs in capture and stops propagation), so the two never
        // double-open the same click.
        let tries = 0
        timer = setInterval(() => {
          tries++
          try {
            const host = resolveOpenInNewTabHost()
            if (host && typeof host.setOpenResourceHandler === 'function') {
              host.setOpenResourceHandler((url, lineNumber, columnNumber) => {
                if (!diminaProjectSourcePath(String(url), cfg)) return
                openInEditor(
                  String(url),
                  typeof lineNumber === 'number' ? lineNumber : undefined,
                  typeof columnNumber === 'number' ? columnNumber : undefined,
                )
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
