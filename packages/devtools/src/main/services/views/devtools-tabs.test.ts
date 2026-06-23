import { describe, expect, it } from 'vitest'
import { DEVTOOLS_KEPT_VIEW_IDS, buildCustomizeTabsScript } from './devtools-tabs.js'

describe('DEVTOOLS_KEPT_VIEW_IDS', () => {
  it('keeps Elements / Console / Network / Sources in the default bar', () => {
    // Sources is kept so a source-link click NOT routed to Monaco (build/runtime
    // chunks, framework frames) still has a panel to reveal in.
    expect([...DEVTOOLS_KEPT_VIEW_IDS]).toEqual(['elements', 'console', 'network', 'sources'])
  })
})

describe('buildCustomizeTabsScript', () => {
  it('produces a self-contained IIFE wrapped in try/catch (silent degradation)', () => {
    const src = buildCustomizeTabsScript()
    expect(src.startsWith('(function(){try{')).toBe(true)
    expect(src.trimEnd().endsWith('})()')).toBe(true)
  })

  it('embeds the keep-list as a JSON data literal, not interpolated identifiers', () => {
    // ids appear only inside a JSON.parse(...) string literal — never as bare code
    // tokens — so a hostile id can never become executable JS.
    const src = buildCustomizeTabsScript(['elements', 'console'])
    expect(src).toContain('JSON.parse(')
    expect(src).toContain('elements')
    expect(src).toContain('console')
  })

  it('drives the DevTools view registry (not globalThis.UI / DOM)', () => {
    const src = buildCustomizeTabsScript()
    expect(src).toContain("import(") // ESM module resolution
    expect(src).toContain('./ui/legacy/legacy.js')
    expect(src).toContain('maybeRemoveViewExtension')
    expect(src).toContain('registerViewExtension')
    expect(src).toContain('getRegisteredViewExtensions')
  })

  it('keeps non-kept panels reachable by registering them transient (not deleting)', () => {
    const src = buildCustomizeTabsScript()
    expect(src).toContain("persistence='transient'")
  })

  it('reorders Sources after Network when Sources is kept', () => {
    const src = buildCustomizeTabsScript()
    // The Sources-last nudge keys off the Sources + Network display-name sets and
    // moves the Sources tab to just after Network.
    expect(src).toContain('WANT_SOURCES_LAST')
    expect(src).toContain('insertBefore')
    expect(src).toContain('源代码')
    // No reorder when Sources is not in the keep-list.
    const noSources = buildCustomizeTabsScript(['elements', 'console', 'network'])
    expect(noSources).toContain('WANT_SOURCES_LAST = KEEPID.has(\'sources\')')
  })

  it('suppresses the locale infobar via the official host preference', () => {
    const src = buildCustomizeTabsScript()
    expect(src).toContain('disable-locale-info-bar')
    expect(src).toContain('setPreference')
  })

  it('bounds its DOM fallback poll so it cannot spin forever', () => {
    const src = buildCustomizeTabsScript()
    expect(src).toContain('clearInterval')
    expect(src).toContain('tr>120')
  })
})
