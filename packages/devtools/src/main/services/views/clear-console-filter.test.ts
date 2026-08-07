import { describe, expect, it } from 'vitest'
import { buildClearConsoleFilterScript } from './clear-console-filter.js'

describe('buildClearConsoleFilterScript', () => {
  it('produces a self-contained IIFE wrapped in try/catch (silent degradation)', () => {
    const src = buildClearConsoleFilterScript()
    expect(src.startsWith('(function(){')).toBe(true)
    expect(src.trimEnd().endsWith('})()')).toBe(true)
  })

  it('removes the stale persisted keys (camel + kebab spellings)', () => {
    const src = buildClearConsoleFilterScript()
    expect(src).toContain("localStorage.removeItem('console.textFilter')")
    expect(src).toContain("localStorage.removeItem('console.text-filter')")
  })

  it('resets the visible filter box through textFilterUI', () => {
    const src = buildClearConsoleFilterScript()
    expect(src).toContain('textFilterUI')
    expect(src).toContain("box.setValue('')")
    expect(src).toContain('updateCurrentFilter')
    expect(src).toContain('onFilterChanged')
  })

  it('probes front-end bootstrap before touching ConsoleView', () => {
    const src = buildClearConsoleFilterScript()
    // The bootstrap probe must run BEFORE any ConsoleView.instance() reach.
    const probeIndex = src.indexOf('ShortcutRegistry.ShortcutRegistry.instance()')
    const consoleViewIndex = src.indexOf('ConsoleView.instance()')
    expect(probeIndex).toBeGreaterThan(-1)
    expect(consoleViewIndex).toBeGreaterThan(probeIndex)
  })

  it('bounds its retry so it cannot spin forever', () => {
    const src = buildClearConsoleFilterScript()
    expect(src).toContain('setTimeout')
    expect(src).toContain('attempts < MAX')
    expect(src).toContain('var MAX = 100')
  })
})
