/** 路径监狱（纯函数，lib 中立）—— fs-core.worker.ts 的写路径统一走这里做归一化/校验。 */
export const DERIVED_PREFIXES = ['node_modules/', '.checkpoints/']

export function normalizePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\')) return null
  if (p.startsWith('/')) return null
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}
