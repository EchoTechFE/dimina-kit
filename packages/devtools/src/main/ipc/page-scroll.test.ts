import { describe, expect, it } from 'vitest'
import { buildPageScrollScript } from './page-scroll'

describe('buildPageScrollScript', () => {
  // ── window.scrollTo presence ────────────────────────────────────────────────

  it('returns a string containing window.scrollTo', () => {
    expect(buildPageScrollScript({})).toContain('window.scrollTo')
  })

  // ── scrollTop coercion ──────────────────────────────────────────────────────

  it('uses scrollTop 0 when scrollTop is missing', () => {
    const script = buildPageScrollScript({})
    expect(script).toContain('top: 0')
  })

  it('uses scrollTop 0 when scrollTop is undefined', () => {
    const script = buildPageScrollScript({ scrollTop: undefined })
    expect(script).toContain('top: 0')
  })

  it('uses scrollTop 0 when scrollTop is NaN-coercible (non-numeric string)', () => {
    const script = buildPageScrollScript({ scrollTop: 'abc' })
    expect(script).toContain('top: 0')
  })

  it('uses the numeric value of a numeric scrollTop', () => {
    const script = buildPageScrollScript({ scrollTop: 120 })
    expect(script).toContain('top: 120')
  })

  it('coerces a numeric string to a number', () => {
    const script = buildPageScrollScript({ scrollTop: '200' })
    expect(script).toContain('top: 200')
  })

  it('uses scrollTop 0 for null-like coercion (null → 0)', () => {
    const script = buildPageScrollScript({ scrollTop: null })
    expect(script).toContain('top: 0')
  })

  // ── duration defaults ───────────────────────────────────────────────────────

  it('defaults duration to 300 (smooth) when duration is missing', () => {
    const script = buildPageScrollScript({ scrollTop: 50 })
    expect(script).toContain('smooth')
    expect(script).not.toContain('auto')
  })

  it('uses smooth behavior when duration > 0', () => {
    const script = buildPageScrollScript({ scrollTop: 50, duration: 500 })
    expect(script).toContain('smooth')
  })

  it('uses auto behavior when duration === 0', () => {
    const script = buildPageScrollScript({ scrollTop: 40, duration: 0 })
    expect(script).toContain('auto')
    expect(script).not.toContain('smooth')
  })

  it('uses auto behavior when duration < 0', () => {
    const script = buildPageScrollScript({ scrollTop: 40, duration: -1 })
    expect(script).toContain('auto')
  })

  // ── combined examples from contract ────────────────────────────────────────

  it('example: scrollTop 120 → includes window.scrollTo, top: 120, smooth', () => {
    const script = buildPageScrollScript({ scrollTop: 120 })
    expect(script).toContain('window.scrollTo')
    expect(script).toContain('top: 120')
    expect(script).toContain('smooth')
  })

  it('example: scrollTop 40, duration 0 → includes top: 40 and auto', () => {
    const script = buildPageScrollScript({ scrollTop: 40, duration: 0 })
    expect(script).toContain('top: 40')
    expect(script).toContain('auto')
  })

  it('example: empty params → includes top: 0', () => {
    const script = buildPageScrollScript({})
    expect(script).toContain('top: 0')
  })

  // ── return type ─────────────────────────────────────────────────────────────

  it('returns a string', () => {
    expect(typeof buildPageScrollScript({ scrollTop: 10 })).toBe('string')
  })
})
