import type { GuestConsoleEntry } from './index.js'

/** dimina framework internal-log first-arg prefixes, from the framework
 *  source literals (dimina/fe/packages/service/src/core/message.js:26 and
 *  siblings use `'[service]'`; dimina/fe/packages/render/src/core/message.js:18
 *  and siblings use `'[system]'`). */
const SERVICE_PREFIX = '[service]'
const RENDER_PREFIX = '[system]'

/**
 * Judges whether a guest console entry is dimina framework-internal output
 * (a bridge/lifecycle log the framework itself prints) rather than the
 * mini-app author's own business `console.*` call. Only the FIRST arg is
 * inspected — framework logs always lead with the literal tag; a
 * business log that happens to mention the tag later in its args must not
 * be swept up.
 */
export function isInternalLogMessage(entry: GuestConsoleEntry): boolean {
  const first = entry.args?.[0]
  if (typeof first !== 'string') return false
  if (first === RENDER_PREFIX) return true
  return first === SERVICE_PREFIX || first.startsWith(`${SERVICE_PREFIX} `)
}
