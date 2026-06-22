/**
 * Pure helpers for the native-host service-console forwarder.
 *
 * The service-host's console is captured via CDP `Runtime.consoleAPICalled`,
 * which preserves native source attribution. A `console.*` monkeypatch in
 * `service-host/preload.cjs` would add a stack frame, so Chrome DevTools (attached
 * natively to the service host) would attribute EVERY service-layer log to the
 * wrapper line instead of the developer's source.
 *
 * These functions turn the CDP event shape into the `GuestConsoleEntry` shape
 * the existing console fan-out (automation `App.logAdded`) expects, WITHOUT any
 * electron / IO dependency so they are unit-testable in isolation. The async
 * deep-fetch (`Runtime.callFunctionOn`) for object args lives in `index.ts`.
 */

/**
 * sourceURL stamped on the render→service `[视图]` re-injection script
 * (`console-forward.buildForwardScript`). The CDP capture skips any
 * `consoleAPICalled` whose top frame carries this URL so a forwarded render line
 * is not re-captured and re-broadcast as a service entry (duplicate / loop).
 */
export const RENDER_FORWARD_SOURCE_URL = 'dimina://render-console-forward'

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug'

/** Subset of a CDP `Runtime.RemoteObject` we read. */
export interface RemoteObjectLike {
  type?: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  objectId?: string
  preview?: {
    properties?: Array<{ name: string; value: string; type: string }>
    subtype?: string
    overflow?: boolean
  }
}

/** Subset of a CDP `Runtime.consoleAPICalled` params we read. */
export interface ConsoleApiParamsLike {
  type?: string
  args?: RemoteObjectLike[]
  stackTrace?: { callFrames?: Array<{ url?: string }> }
}

const KNOWN_LEVELS: ReadonlySet<string> = new Set(['log', 'warn', 'error', 'info', 'debug'])

/**
 * CDP `consoleAPICalled.type` → our console level. CDP emits `'warning'` where
 * we use `'warn'`; every other known level passes through; anything else (e.g.
 * `'dir'`, `'table'`, `'trace'`, `undefined`) maps to `'log'`.
 */
export function mapConsoleApiType(type: string | undefined): ConsoleLevel {
  if (type === 'warning') return 'warn'
  if (type && KNOWN_LEVELS.has(type)) return type as ConsoleLevel
  return 'log'
}

const BIGINT_LITERAL = /^-?\d+n$/

/**
 * A single RemoteObject → a JSON-serializable value WITHOUT a CDP round-trip
 * (shallow). Objects that need their full contents are flagged by
 * {@link needsDeepFetch} and deep-serialized by the caller; this is the
 * inline/best-effort fallback.
 */
export function remoteObjectToValue(ro: RemoteObjectLike): unknown {
  if (!ro) return ro
  // 1. An inlined value (CDP includes `value` for JSON-serializable primitives
  //    and small arrays). Use `in` so falsy values (0, '', false) and an
  //    explicit `null` are honoured rather than falling through.
  if ('value' in ro) return ro.value
  // 2. Specials that can't ride in `value`.
  if (typeof ro.unserializableValue === 'string') {
    const u = ro.unserializableValue
    if (u === 'Infinity') return Infinity
    if (u === '-Infinity') return -Infinity
    if (u === 'NaN') return NaN
    if (u === '-0') return -0
    if (BIGINT_LITERAL.test(u)) return u
    return u
  }
  // 3. Fall back by type.
  switch (ro.type) {
    case 'undefined':
      return undefined
    case 'function':
      return ro.description ?? '[Function]'
    case 'symbol':
      return ro.description ?? '[Symbol]'
    case 'object':
      if (ro.subtype === 'null') return null
      return ro.description ?? '[Object]'
    default:
      return ro.description ?? '[Unknown]'
  }
}

/**
 * Whether this RemoteObject must be deep-fetched via `Runtime.callFunctionOn`
 * (returnByValue) to be fully serialized — i.e. a real object/array referenced
 * by `objectId` with no inline `value`. Functions, primitives, `null`, and
 * already-inlined values do not.
 */
export function needsDeepFetch(ro: RemoteObjectLike): boolean {
  if (!ro) return false
  if ('value' in ro) return false
  return ro.type === 'object' && ro.subtype !== 'null' && typeof ro.objectId === 'string'
}

/**
 * True when a `consoleAPICalled` event is the render→service `[视图]`
 * re-injection (its top call frame URL === the sentinel) and must NOT be
 * re-forwarded — the original render entry already reached every consumer.
 */
export function isRenderForwardEvent(params: ConsoleApiParamsLike, sentinelUrl: string): boolean {
  const top = params?.stackTrace?.callFrames?.[0]?.url
  return typeof top === 'string' && top === sentinelUrl
}
