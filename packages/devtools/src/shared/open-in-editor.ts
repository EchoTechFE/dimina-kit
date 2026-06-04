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
  expectedOrigin?: string,
): string | null {
  if (typeof resourceUrl !== 'string' || !resourceUrl) return null
  let resource: URL
  try {
    resource = new URL(resourceUrl)
  } catch {
    return null
  }
  // Only http(s) dev-server sources map to project files; schemes like
  // `webpack://`, `node:`, `data:` are framework/runtime frames with no file.
  if (resource.protocol !== 'http:' && resource.protocol !== 'https:') return null
  if (expectedOrigin) {
    let base: URL
    try { base = new URL(expectedOrigin) } catch { return null }
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
