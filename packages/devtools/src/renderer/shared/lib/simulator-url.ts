import type { CompileConfig } from '../types'

/**
 * Build simulator URL from app info and compile config.
 * Pure function for easy testing.
 */
export function buildSimulatorUrl(
  appId: string,
  compileConfig: CompileConfig,
  port: number,
  apiNamespaces?: string[]
): string {
  const pg = compileConfig.startPage || 'pages/index/index'
  const params = (compileConfig.queryParams || [])
    .filter((p) => p.key)
    .map(
      (p) =>
        `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`
    )
  params.push(`scene=${compileConfig.scene || 1001}`)
  const qs = apiNamespaces?.length ? `?apiNamespaces=${apiNamespaces.join(',')}` : ''
  return `http://localhost:${port}/simulator.html${qs}#${appId}|${pg}?${params.join('&')}`
}

/**
 * Extract current page path from simulator URL.
 */
export function extractCurrentPage(url: string): string {
  const hash = url.split('#')[1]
  if (!hash) return ''
  // Hash format: {appId}|{pagePath}?{query}
  const pipeIdx = hash.indexOf('|')
  if (pipeIdx === -1) return hash.split('?')[0].split('/').slice(1).join('/')
  return hash.slice(pipeIdx + 1).split('?')[0]
}

/**
 * Collapse a simulator URL whose hash has accumulated a navigation stack
 * (`{appId}|page1|page2|...|topPage?query`) down to just the top page
 * (`{appId}|topPage?query`).
 *
 * Why: a hot-reload triggers `webview.reload()`, which re-parses the
 * existing URL hash on init. With a multi-page stack the simulator asks
 * for a merged bundle (`pages_a|pages_b.css`) that the compiler never
 * emits, so pageFrame renders blank. Trimming the hash to the top page
 * makes the simulator re-init at exactly that page, requesting only the
 * single-page bundle that does exist on disk.
 */
export function collapseHashToTopPage(url: string): string {
  const [base, hash] = url.split('#')
  if (!hash) return url
  const [stack, query] = hash.split('?')
  const segments = stack.split('|')
  if (segments.length <= 2) return url
  const newHash = `${segments[0]}|${segments[segments.length - 1]}`
  return `${base}#${newHash}${query ? `?${query}` : ''}`
}
