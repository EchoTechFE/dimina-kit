/**
 * `computeNeedsRestart` decides whether the debug tab shows the "restart
 * required" nag. It only compares config against the last-observed CDP
 * status, so these tests pin the truth table rather than the render.
 *
 * `THEME_LABELS` is the pure lookup table backing the theme selector; the
 * test just guards the mapping stays complete and correct.
 */
import { describe, expect, it } from 'vitest'
import { computeNeedsRestart, THEME_LABELS } from './workbench-settings'
import type { CdpStatus, WorkbenchSettingsValue } from '@/shared/api'

function cdpStatus(overrides: Partial<CdpStatus> = {}): CdpStatus {
  return {
    configured: true,
    port: 9222,
    active: false,
    activePort: null,
    implicitDevDefault: false,
    ...overrides,
  }
}

function cdpConfig(overrides: Partial<WorkbenchSettingsValue['cdp']> = {}): WorkbenchSettingsValue['cdp'] {
  return { enabled: false, port: 9222, ...overrides }
}

describe('computeNeedsRestart', () => {
  it('never nags before any status has been observed', () => {
    expect(computeNeedsRestart(null, cdpConfig({ enabled: true }))).toBe(false)
  })

  it('never nags while dev mode is implicitly listening', () => {
    const status = cdpStatus({ active: true, activePort: 9222, implicitDevDefault: true })
    // Even a mismatched config shouldn't nag under the implicit dev default.
    expect(computeNeedsRestart(status, cdpConfig({ enabled: false, port: 1 }))).toBe(false)
  })

  it('nags when enabled toggled on but CDP is not yet active', () => {
    const status = cdpStatus({ active: false })
    expect(computeNeedsRestart(status, cdpConfig({ enabled: true }))).toBe(true)
  })

  it('nags when enabled toggled off but CDP is still active', () => {
    const status = cdpStatus({ active: true, activePort: 9222 })
    expect(computeNeedsRestart(status, cdpConfig({ enabled: false }))).toBe(true)
  })

  it('does not nag when both sides agree CDP is off, regardless of the configured port', () => {
    const status = cdpStatus({ active: false, activePort: null })
    expect(computeNeedsRestart(status, cdpConfig({ enabled: false, port: 4000 }))).toBe(false)
  })

  it('does not nag when enabled and the configured port matches the active port', () => {
    const status = cdpStatus({ active: true, activePort: 9222 })
    expect(computeNeedsRestart(status, cdpConfig({ enabled: true, port: 9222 }))).toBe(false)
  })

  it('nags when enabled and active but the configured port differs from the active port', () => {
    const status = cdpStatus({ active: true, activePort: 9222 })
    expect(computeNeedsRestart(status, cdpConfig({ enabled: true, port: 9333 }))).toBe(true)
  })
})

describe('THEME_LABELS', () => {
  it('maps every theme source to its display label', () => {
    expect(THEME_LABELS).toEqual({
      system: '跟随系统',
      dark: '深色',
      light: '浅色',
    })
  })
})
