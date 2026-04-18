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
