/**
 * RED tests for the pure helpers backing CDP-based service console capture.
 *
 * The service layer is moving from monkeypatching `console.*` to listening on
 * CDP `Runtime.consoleAPICalled`. These helpers convert CDP RemoteObjects into
 * JSON-serializable values WITHOUT a CDP round-trip, decide when a deep fetch
 * IS required, and filter out the render→service `[视图]` forward re-injection
 * so automation doesn't see each render entry twice.
 *
 * Pure functions only — no electron, no IO, so no `vi.mock('electron')`.
 *
 * NOTE: `./console-api.js` does not exist yet. These tests are expected to FAIL
 * at import time (RED). Implementation comes after.
 */
import { describe, it, expect } from 'vitest'
import {
  RENDER_FORWARD_SOURCE_URL,
  mapConsoleApiType,
  remoteObjectToValue,
  needsDeepFetch,
  isRenderForwardEvent,
} from './console-api.js'

describe('RENDER_FORWARD_SOURCE_URL', () => {
  it('is a stable, non-empty string sentinel', () => {
    // If this becomes '' or non-string, isRenderForwardEvent's url-equality
    // would either match every empty url or throw — both break loop-safety.
    expect(typeof RENDER_FORWARD_SOURCE_URL).toBe('string')
    expect(RENDER_FORWARD_SOURCE_URL.length).toBeGreaterThan(0)
  })
})

describe('mapConsoleApiType', () => {
  it("maps CDP 'warning' to our 'warn' (the names differ)", () => {
    // CDP emits 'warning'; our console level is 'warn'. A naive pass-through
    // would leak 'warning' downstream and break level styling/filtering.
    expect(mapConsoleApiType('warning')).toBe('warn')
  })

  it('passes through known levels unchanged', () => {
    expect(mapConsoleApiType('log')).toBe('log')
    expect(mapConsoleApiType('error')).toBe('error')
    expect(mapConsoleApiType('info')).toBe('info')
    expect(mapConsoleApiType('debug')).toBe('debug')
  })

  it("falls back to 'log' for unknown CDP types", () => {
    // CDP has types like 'dir', 'table', 'trace', 'assert', 'count' that we
    // don't model — they must degrade to 'log', not pass through raw.
    expect(mapConsoleApiType('table')).toBe('log')
    expect(mapConsoleApiType('trace')).toBe('log')
    expect(mapConsoleApiType('totally-bogus')).toBe('log')
  })

  it("falls back to 'log' when type is undefined", () => {
    expect(mapConsoleApiType(undefined)).toBe('log')
  })
})

describe('remoteObjectToValue', () => {
  it('returns the inline string value', () => {
    expect(remoteObjectToValue({ type: 'string', value: 'hello' })).toBe('hello')
  })

  it('returns the inline number value', () => {
    expect(remoteObjectToValue({ type: 'number', value: 42 })).toBe(42)
  })

  it('returns the inline boolean value', () => {
    expect(remoteObjectToValue({ type: 'boolean', value: true })).toBe(true)
  })

  it('returns null when value is explicitly null (must NOT fall through)', () => {
    // The bug this guards: treating `value:null` as "no value" and falling into
    // the type-based branches (which for object subtype null also yields null,
    // but for other shapes would be wrong). value:null is a real inline value.
    expect(remoteObjectToValue({ type: 'object', subtype: 'null', value: null })).toBeNull()
  })

  it('returns falsy inline values verbatim: 0', () => {
    // `if (ro.value)` would drop 0 — must use a presence check ('value' in ro).
    expect(remoteObjectToValue({ type: 'number', value: 0 })).toBe(0)
  })

  it('returns falsy inline values verbatim: false', () => {
    expect(remoteObjectToValue({ type: 'boolean', value: false })).toBe(false)
  })

  it('returns falsy inline values verbatim: empty string', () => {
    expect(remoteObjectToValue({ type: 'string', value: '' })).toBe('')
  })

  it('returns an inline array value as-is', () => {
    expect(remoteObjectToValue({ type: 'object', subtype: 'array', value: [1, 2, 3] })).toEqual([1, 2, 3])
  })

  it("decodes unserializableValue 'NaN' to a real NaN", () => {
    const v = remoteObjectToValue({ type: 'number', unserializableValue: 'NaN' })
    expect(Number.isNaN(v)).toBe(true)
  })

  it("decodes unserializableValue 'Infinity' and '-Infinity'", () => {
    expect(remoteObjectToValue({ type: 'number', unserializableValue: 'Infinity' })).toBe(Infinity)
    expect(remoteObjectToValue({ type: 'number', unserializableValue: '-Infinity' })).toBe(-Infinity)
  })

  it("decodes unserializableValue '-0' to negative zero (Object.is)", () => {
    // 0 and -0 are === equal; only Object.is distinguishes them. A naive
    // Number('-0') already gives -0, but a switch that returns 0 would not.
    const v = remoteObjectToValue({ type: 'number', unserializableValue: '-0' })
    expect(Object.is(v, -0)).toBe(true)
  })

  it("returns a BigInt literal unserializableValue as the raw string", () => {
    // BigInt can't be JSON-serialized; the contract keeps the '42n' literal
    // string so it survives the wire intact.
    expect(remoteObjectToValue({ type: 'bigint', unserializableValue: '42n' })).toBe('42n')
    expect(remoteObjectToValue({ type: 'bigint', unserializableValue: '-7n' })).toBe('-7n')
  })

  it('prefers an inline value over unserializableValue when both present', () => {
    // value has higher priority per the contract.
    expect(remoteObjectToValue({ type: 'number', value: 5, unserializableValue: 'NaN' })).toBe(5)
  })

  it("returns undefined for type 'undefined'", () => {
    expect(remoteObjectToValue({ type: 'undefined' })).toBeUndefined()
  })

  it("returns the function's description (no round-trip)", () => {
    expect(
      remoteObjectToValue({ type: 'function', description: 'function foo() {}', objectId: 'fn-1' }),
    ).toBe('function foo() {}')
  })

  it("returns '[Function]' for a function lacking a description", () => {
    expect(remoteObjectToValue({ type: 'function', objectId: 'fn-2' })).toBe('[Function]')
  })

  it("returns the symbol's description", () => {
    expect(remoteObjectToValue({ type: 'symbol', description: 'Symbol(x)' })).toBe('Symbol(x)')
  })

  it("returns '[Symbol]' for a symbol lacking a description", () => {
    expect(remoteObjectToValue({ type: 'symbol' })).toBe('[Symbol]')
  })

  it("returns null for an object with subtype 'null' and no inline value", () => {
    expect(remoteObjectToValue({ type: 'object', subtype: 'null' })).toBeNull()
  })

  it("returns the object's description when present (no inline value)", () => {
    expect(
      remoteObjectToValue({ type: 'object', description: 'Array(3)', objectId: 'obj-1' }),
    ).toBe('Array(3)')
  })

  it("returns '[Object]' for an object with neither value nor description", () => {
    expect(remoteObjectToValue({ type: 'object', objectId: 'obj-2' })).toBe('[Object]')
  })

  it('falls back to a non-empty best-effort string for an unknown type', () => {
    // Forward-compat: an unexpected RemoteObject.type must still yield a usable,
    // non-empty value rather than undefined/''.
    const v = remoteObjectToValue({ type: 'weirdtype', description: 'weird-desc' })
    expect(v).toBe('weird-desc')
  })
})

describe('needsDeepFetch', () => {
  it('is true for a plain object with an objectId and no inline value', () => {
    // This is the only case a CDP round-trip (callFunctionOn returnByValue)
    // is warranted — the shallow value would just be '[Object]'.
    expect(needsDeepFetch({ type: 'object', objectId: 'obj-1' })).toBe(true)
  })

  it("is false for an object with subtype 'null' even if it has an objectId", () => {
    expect(needsDeepFetch({ type: 'object', subtype: 'null', objectId: 'obj-n' })).toBe(false)
  })

  it('is false for an array that already carries an inline value', () => {
    // Inline value present → no fetch needed; the data is already complete.
    expect(needsDeepFetch({ type: 'object', subtype: 'array', objectId: 'arr-1', value: [1, 2] })).toBe(false)
  })

  it('is false for a function even with an objectId', () => {
    expect(needsDeepFetch({ type: 'function', objectId: 'fn-1' })).toBe(false)
  })

  it('is false for a primitive (no objectId)', () => {
    expect(needsDeepFetch({ type: 'string', value: 'x' })).toBe(false)
    expect(needsDeepFetch({ type: 'number', value: 1 })).toBe(false)
  })

  it('is false for an object that has no objectId', () => {
    // Without an objectId there is nothing to call CDP against.
    expect(needsDeepFetch({ type: 'object', description: 'Foo' })).toBe(false)
  })
})

describe('isRenderForwardEvent', () => {
  it("is true when the top call frame url equals the sentinel", () => {
    const params = { type: 'log', stackTrace: { callFrames: [{ url: 'dimina://forward' }] } }
    expect(isRenderForwardEvent(params, 'dimina://forward')).toBe(true)
  })

  it('is true when matched against the exported RENDER_FORWARD_SOURCE_URL constant', () => {
    // Guards the real wiring: events injected with the constant's url must be
    // recognized as forwards and skipped to avoid double-forwarding.
    const params = {
      type: 'log',
      stackTrace: { callFrames: [{ url: RENDER_FORWARD_SOURCE_URL }] },
    }
    expect(isRenderForwardEvent(params, RENDER_FORWARD_SOURCE_URL)).toBe(true)
  })

  it('is false when the top frame url is some other script', () => {
    const params = {
      type: 'log',
      stackTrace: { callFrames: [{ url: 'https://app/page.js' }] },
    }
    expect(isRenderForwardEvent(params, 'dimina://forward')).toBe(false)
  })

  it('only inspects the TOP frame, not deeper frames', () => {
    // A normal user log may have the sentinel deeper in the stack; only the
    // top frame being the sentinel marks it as a re-injection.
    const params = {
      type: 'log',
      stackTrace: { callFrames: [{ url: 'https://app/page.js' }, { url: 'dimina://forward' }] },
    }
    expect(isRenderForwardEvent(params, 'dimina://forward')).toBe(false)
  })

  it('is false when stackTrace is missing', () => {
    expect(isRenderForwardEvent({ type: 'log' }, 'dimina://forward')).toBe(false)
  })

  it('is false when callFrames is an empty array', () => {
    const params = { type: 'log', stackTrace: { callFrames: [] } }
    expect(isRenderForwardEvent(params, 'dimina://forward')).toBe(false)
  })

  it('is false when the top frame has no url', () => {
    const params = { type: 'log', stackTrace: { callFrames: [{}] } }
    expect(isRenderForwardEvent(params, 'dimina://forward')).toBe(false)
  })
})
