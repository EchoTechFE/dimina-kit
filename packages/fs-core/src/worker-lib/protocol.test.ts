/**
 * Guards the exported wire contract: consumers match rejections via
 * `isFsCoreErrorCode`/`getFsCoreErrorCode` against the SAME code list the
 * worker's `rpcErr` factory is typed against — so a code the worker can
 * throw and a code a consumer can match are one set by construction.
 */
import { describe, expect, it } from 'vitest'
import { FS_CORE_ERROR_CODES, getFsCoreErrorCode, isFsCoreErrorCode } from './protocol.js'
import { rpcErr } from './engine-shared.js'

describe('fs-core error-code contract', () => {
  it('recognizes an error produced by the worker-side rpcErr factory', () => {
    const e = rpcErr('turn-closed', 'turn expired: t-1')
    expect(getFsCoreErrorCode(e)).toBe('turn-closed')
    expect(isFsCoreErrorCode(e, 'turn-closed')).toBe(true)
    expect(isFsCoreErrorCode(e, 'readonly')).toBe(false)
  })

  it('recognizes the plain-object shape a structured-clone/client rejection carries', () => {
    // client.ts materializes rejections as Object.assign(new Error(msg), {code})
    const clientShaped = Object.assign(new Error('fs-core is readonly'), { code: 'readonly' })
    expect(getFsCoreErrorCode(clientShaped)).toBe('readonly')
    expect(isFsCoreErrorCode(clientShaped, 'readonly')).toBe(true)
  })

  it('returns undefined for non-fs-core errors, unknown codes, and non-objects', () => {
    expect(getFsCoreErrorCode(new Error('plain'))).toBeUndefined()
    expect(getFsCoreErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeUndefined()
    expect(getFsCoreErrorCode(null)).toBeUndefined()
    expect(getFsCoreErrorCode('readonly')).toBeUndefined()
    expect(isFsCoreErrorCode(undefined, 'readonly')).toBe(false)
  })

  it('lists every code exactly once', () => {
    expect(new Set(FS_CORE_ERROR_CODES).size).toBe(FS_CORE_ERROR_CODES.length)
  })
})
