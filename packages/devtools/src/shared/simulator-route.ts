/**
 * Single source of truth for the simulator URL format.
 *
 * Upstream dimina (didi/dimina, since commit 68310fe) encodes the page route
 * as query params: `?appId={id}&entry={spec}&page={spec}` where each spec is
 * `pagePath?key=val&…`. HashRouter.syncStack rewrites the URL after every
 * navigation; before mount, parent code consumes whatever URL it received.
 *
 * Older containers wrote the route into the URL hash; we still parse that as
 * a fallback so e2e tests / hot-reload paths survive a bisect across versions.
 *
 * Every URL-building or URL-parsing site in devtools should go through this
 * module — if upstream changes the contract again it's a single-file diff.
 */

import type { CompileConfig } from './types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface PageSpec {
  pagePath: string
  /** Per-page query parsed out of `pagePath?k=v&…`. */
  query: Record<string, string>
}

export interface SimulatorRoute {
  appId: string
  entry: PageSpec
  /** Defaults to `entry` when the URL has only one segment. */
  current: PageSpec
}

const ROUTE_KEYS = ['appId', 'entry', 'page'] as const

// ── Low-level encode / decode ────────────────────────────────────────────────

/**
 * Encode a search-param value but leave `/` and `,` un-escaped for
 * readability. Upstream `HashRouter._encodeSearchValue` only spares `/`;
 * we also spare `,` so CSV-style extras (e.g. `apiNamespaces=qd,mt`) stay
 * legible in the URL. Both characters are safe in a query string.
 */
export function encodeRouteValue(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, '/').replace(/%2C/g, ',')
}

/** Encode `{ pagePath, query }` as `pagePath?k1=v1&k2=v2` (no trailing `?` when empty). */
export function encodePageSpec(spec: PageSpec): string {
  const keys = Object.keys(spec.query)
  if (keys.length === 0) return spec.pagePath
  const qs = keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(spec.query[k] ?? '')}`)
    .join('&')
  return `${spec.pagePath}?${qs}`
}

/** Decode `pagePath?k=v` into `{ pagePath, query }`. Tolerates missing query. */
export function decodePageSpec(value: string): PageSpec {
  const qIdx = value.indexOf('?')
  if (qIdx < 0) return { pagePath: value, query: {} }
  const pagePath = value.slice(0, qIdx)
  const query: Record<string, string> = {}
  for (const pair of value.slice(qIdx + 1).split('&')) {
    if (!pair) continue
    const eqIdx = pair.indexOf('=')
    const k = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair
    const v = eqIdx >= 0 ? pair.slice(eqIdx + 1) : ''
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v)
  }
  return { pagePath, query }
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Build the search-params string (without a leading `?`) for a route where
 * `entry === current`. `extras` is appended verbatim (e.g. `apiNamespaces`).
 */
export function buildRouteSearch(
  appId: string,
  page: PageSpec,
  extras: Record<string, string> = {},
): string {
  const spec = encodePageSpec(page)
  const params = [
    `appId=${encodeRouteValue(appId)}`,
    `entry=${encodeRouteValue(spec)}`,
    `page=${encodeRouteValue(spec)}`,
  ]
  for (const [k, v] of Object.entries(extras)) {
    if (ROUTE_KEYS.includes(k as (typeof ROUTE_KEYS)[number])) continue
    params.push(`${encodeURIComponent(k)}=${encodeRouteValue(v)}`)
  }
  return params.join('&')
}

/**
 * Build a full simulator URL. The default `host`/`pathname` match what the
 * devkit dev server serves; both are overridable for tests.
 */
export function buildSimulatorUrlFromSpec(opts: {
  appId: string
  page: PageSpec
  port: number
  host?: string
  pathname?: string
  extras?: Record<string, string>
}): string {
  const host = opts.host ?? 'localhost'
  const pathname = opts.pathname ?? '/simulator.html'
  const search = buildRouteSearch(opts.appId, opts.page, opts.extras ?? {})
  return `http://${host}:${opts.port}${pathname}?${search}`
}

/**
 * Renderer-facing convenience: build a simulator URL from devtools'
 * `CompileConfig` shape (startPage / scene / queryParams).
 */
export function buildSimulatorUrl(
  appId: string,
  compileConfig: CompileConfig,
  port: number,
  apiNamespaces?: string[],
): string {
  const pagePath = compileConfig.startPage || 'pages/index/index'
  const query: Record<string, string> = {}
  for (const p of compileConfig.queryParams ?? []) {
    if (p.key) query[p.key] = p.value
  }
  query.scene = String(compileConfig.scene ?? 1001)
  const extras: Record<string, string> = {}
  if (apiNamespaces?.length) extras.apiNamespaces = apiNamespaces.join(',')
  return buildSimulatorUrlFromSpec({
    appId,
    page: { pagePath, query },
    port,
    extras,
  })
}

// ── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse `location.search` + `location.hash` into a `SimulatorRoute`.
 * Prefers the new query format; falls back to the legacy hash format.
 * Returns `null` when no recognisable route is present.
 */
export function parseLocationRoute(search: string, hash: string): SimulatorRoute | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const appId = params.get('appId')
  const entryRaw = params.get('entry')
  if (appId && entryRaw) {
    const entry = decodePageSpec(entryRaw)
    const pageRaw = params.get('page')
    const current = pageRaw && pageRaw !== entryRaw ? decodePageSpec(pageRaw) : entry
    return { appId, entry, current }
  }

  // Legacy hash format: `#appid|page1|page2|…` (per-segment ?query)
  const clean = hash.replace(/^#/, '')
  if (!clean) return null
  if (clean.includes('|')) {
    const parts = clean.split('|')
    const legacyAppId = parts[0] ?? ''
    if (!legacyAppId || parts.length < 2) return null
    const entry = decodePageSpec(parts[1] ?? '')
    const current = decodePageSpec(parts[parts.length - 1] ?? '')
    return { appId: legacyAppId, entry, current }
  }
  // Even older: `#appid/pagePath?query` — strip the appid prefix.
  const seg = decodePageSpec(clean)
  const slashIdx = seg.pagePath.indexOf('/')
  if (slashIdx < 0) return null
  const legacyAppId = seg.pagePath.slice(0, slashIdx)
  const pagePath = seg.pagePath.slice(slashIdx + 1)
  if (!legacyAppId || !pagePath) return null
  const spec: PageSpec = { pagePath, query: seg.query }
  return { appId: legacyAppId, entry: spec, current: spec }
}

/** Parse a full URL string into a `SimulatorRoute`, or `null`. */
export function parseRoute(url: string): SimulatorRoute | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return parseLocationRoute(u.search, u.hash)
  } catch {
    return null
  }
}

// ── Convenience helpers ──────────────────────────────────────────────────────

/** Return the current page path (no query) from a URL, or `''` if unparseable. */
export function getCurrentPagePath(url: string): string {
  const route = parseRoute(url)
  return route?.current.pagePath ?? ''
}

/**
 * Rewrite the URL so `entry === current`. Used before a hot-reload so the
 * container boots at just the top page — avoids merged-bundle requests for a
 * multi-page stack that the incremental compiler never emits.
 */
export function collapseRouteToTopPage(url: string): string {
  if (!url) return url
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const route = parseLocationRoute(u.search, u.hash)
  if (!route) return url
  if (route.entry.pagePath === route.current.pagePath
      && encodePageSpec(route.entry) === encodePageSpec(route.current)) {
    return url
  }
  // Preserve non-route extras (apiNamespaces etc.) from the *query* portion.
  // Detect whether the input already carried the new query route — if so we
  // keep `u.hash` (could hold a non-route fragment). If we parsed via the
  // legacy hash fallback, the hash IS the route we just migrated away from
  // and must be dropped so the output URL has a single, canonical route.
  const searchParams = new URLSearchParams(u.search.startsWith('?') ? u.search.slice(1) : u.search)
  const camefromQuery = searchParams.has('appId') && searchParams.has('entry')
  const extras: Record<string, string> = {}
  for (const [k, v] of searchParams) {
    if (!ROUTE_KEYS.includes(k as (typeof ROUTE_KEYS)[number])) extras[k] = v
  }
  const search = buildRouteSearch(route.appId, route.current, extras)
  const trailingHash = camefromQuery ? u.hash : ''
  return `${u.origin}${u.pathname}?${search}${trailingHash}`
}
