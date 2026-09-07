/**
 * Document URL for the Electron render host.
 *
 * The runtime SDK (pageFrame/native-host files) lives under a dedicated
 * `/__sdk__/` subtree on the `dmb-resource` origin. The render-host document
 * itself, though, is placed directly under the page's own package path
 * (`/<appId>/<root>/<page directory>/__frame__.html`, no separate virtual
 * prefix) so a browser-relative package path written in that page's WXML
 * (`../../static/…`) resolves, via the browser's own relative-URL algorithm,
 * to the correct `/<appId>/<root>/static/…` location — the document's own
 * directory depth has to match the page's real directory depth inside the
 * package for that to work, which is the whole reason appId/root/page
 * directory are encoded into the URL path and not just carried in the query
 * string. `__frame__.html` is a reserved name (see `DMB_PAGEFRAME_DOC_NAME`)
 * that can't collide with a real compiled package file.
 */

/** dmb-resource origin subtree for runtime SDK assets (pageFrame, native-host). */
export const DMB_SDK_PREFIX = '/__sdk__/'

/**
 * Reserved render-host document filename. The document lives directly under
 * the page's own package path (`/<appId>/<root>/<page directory>/…`, no
 * separate virtual prefix — `handleDmbResourceRequest` just checks whether a
 * package-path request's last segment is this name and, if so, serves it
 * from the SDK dist instead of proxying it). Double-underscore, matching
 * `DMB_SDK_PREFIX`'s convention, so it can't collide with a real compiled
 * package file.
 */
export const DMB_PAGEFRAME_DOC_NAME = '__frame__.html'

export interface RenderHostDocumentUrlOptions {
  bridgeId: string
  appId: string
  /** The page's resource root inside the mini-app package (e.g. `'main'`). */
  root: string
  pagePath: string
  isTab?: boolean
  /** The page's resolved `navigationStyle` (page ∪ app-level). Surfaced on the
   *  URL as `navStyle` so main can pick the TOP safe-area policy at
   *  `did-attach-webview` — only a `custom` (full-bleed) page borders the
   *  unsafe top zone; a default-nav page starts below the shell nav bar. */
  navigationStyle?: 'default' | 'custom'
  backgroundColor?: string
}

/**
 * Build the navigation URL for a render-host `<webview>`.
 *
 * Hostname is the bridgeId so `protocol.handle('dmb-resource')` can resolve
 * the AppSession. The path encodes `appId/root/<page directory>` (the page's
 * own filename is dropped) so the document's directory depth matches the
 * page's directory depth inside the package — a hand-written relative
 * resource reference in that page's WXML then resolves, via the browser's
 * own WHATWG relative-URL algorithm, to the correct package-relative path
 * instead of an SDK- or origin-relative one.
 */
export function buildRenderHostDocumentUrl(opts: RenderHostDocumentUrlOptions): string {
  // appId/root each become exactly one path segment below. A literal '/'
  // survives encodeURIComponent as '%2F' — one segment to the browser's own
  // relative-URL resolution, but two once the server decodes it back to '/'
  // — silently misaligning the document's apparent directory depth against
  // the package's real depth (the exact invariant this function exists to
  // keep correct). '.'/'..' get normalized away by `new URL(...)` itself,
  // which would silently eat into that same depth — so page-directory
  // segments get the same check as appId/root, not just a '/' check.
  // '\' gets the same treatment as '/': mini-app page paths are always
  // POSIX-style, so a backslash reaching here means either a compiler bug
  // emitting a native (Windows) separator or the depth invariant is already
  // broken — either way it must not be split silently, since
  // `opts.pagePath.split('/')` on a backslash-only path returns a single
  // element and silently drops every directory segment.
  const PATH_SEPARATOR_RE = /[/\\]/
  for (const [name, value] of [['appId', opts.appId], ['root', opts.root]] as const) {
    if (PATH_SEPARATOR_RE.test(value) || value === '.' || value === '..') {
      throw new Error(`[dmb-resource-url] ${name} must be a single path segment, got ${JSON.stringify(value)}`)
    }
  }

  const pageDirSegments = opts.pagePath.split(PATH_SEPARATOR_RE).slice(0, -1).filter(Boolean)
  for (const segment of pageDirSegments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`[dmb-resource-url] pagePath must not contain '.'/'..' segments, got ${JSON.stringify(opts.pagePath)}`)
    }
  }
  const pathSegments = [opts.appId, opts.root, ...pageDirSegments, DMB_PAGEFRAME_DOC_NAME]
    .map(encodeURIComponent)
  const url = new URL(`dmb-resource://${opts.bridgeId}/${pathSegments.join('/')}`)
  url.searchParams.set('bridgeId', opts.bridgeId)
  url.searchParams.set('appId', opts.appId)
  url.searchParams.set('root', opts.root)
  url.searchParams.set('pagePath', opts.pagePath)
  if (opts.isTab) url.searchParams.set('isTab', '1')
  if (opts.navigationStyle === 'custom') url.searchParams.set('navStyle', 'custom')
  if (opts.backgroundColor) url.searchParams.set('bgColor', opts.backgroundColor)
  return url.toString()
}
