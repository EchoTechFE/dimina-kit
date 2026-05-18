/**
 * Phase 2 contract: `resolveTemplates(builtin, injected, mode)` merges the
 * built-in template catalog with a host-injected catalog, honouring the
 * `builtinTemplates` policy on `WorkbenchAppConfig`.
 *
 * Bugs each test catches:
 *  - `mode='all'` regression that accidentally drops a built-in template:
 *    the user would lose `blank` after a refactor, breaking the default
 *    new-project flow.
 *  - `mode='none'` regression that leaks built-ins back into the catalog:
 *    a downstream host (qdmp) that wants to ship only its own templates
 *    would suddenly start showing our blank/taro-todo too.
 *  - Whitelist regression that ignores the array and shows everything,
 *    leaking unsupported templates.
 *  - Same-id override regression where the host's template loses to the
 *    built-in instead of replacing it — a critical extension point for
 *    customising even our default templates.
 *
 * The resolveTemplates function MUST be deterministic and pure — order of
 * the returned list is: injected (in input order, overriding any same-id
 * built-in) ++ remaining built-ins (in their input order).
 */
import { describe, it, expect } from 'vitest'
import { resolveTemplates } from './templates.js'
import type { ProjectTemplate } from './types.js'

const builtin: ProjectTemplate[] = [
  { id: 'blank', name: 'Blank' },
  { id: 'taro-todo', name: 'Taro Todo' },
]

describe('resolveTemplates — built-in policy and injection', () => {
  it("mode='all' keeps every built-in template when no injection is supplied", () => {
    expect(resolveTemplates(builtin, [], 'all').map((t) => t.id)).toEqual([
      'blank',
      'taro-todo',
    ])
  })

  it("mode='none' drops every built-in even when no injection is supplied (returns [])", () => {
    expect(resolveTemplates(builtin, [], 'none')).toEqual([])
  })

  it('whitelist array keeps ONLY listed built-ins, in the whitelist order', () => {
    // Whitelist limits the built-in subset; injected templates are unaffected.
    expect(
      resolveTemplates(builtin, [], ['taro-todo']).map((t) => t.id),
    ).toEqual(['taro-todo'])
  })

  it('whitelist with an unknown id silently drops it (no throw, no phantom entry)', () => {
    expect(
      resolveTemplates(builtin, [], ['blank', 'unknown']).map((t) => t.id),
    ).toEqual(['blank'])
  })

  it("same-id injection replaces the built-in (host's version wins)", () => {
    const injected: ProjectTemplate[] = [
      { id: 'blank', name: 'Host Blank Override', description: 'custom' },
    ]
    const out = resolveTemplates(builtin, injected, 'all')
    const blank = out.find((t) => t.id === 'blank')!
    expect(blank.name).toBe('Host Blank Override')
    expect(blank.description).toBe('custom')
    // taro-todo (the un-overridden built-in) is still present.
    expect(out.find((t) => t.id === 'taro-todo')).toBeDefined()
    // Result must not double-list 'blank'.
    expect(out.filter((t) => t.id === 'blank')).toHaveLength(1)
  })

  it('injection adds a fresh template when the id is not in built-ins', () => {
    const injected: ProjectTemplate[] = [
      { id: 'custom', name: 'Custom Stack' },
    ]
    const ids = resolveTemplates(builtin, injected, 'all').map((t) => t.id)
    expect(ids).toContain('custom')
    expect(ids).toContain('blank')
    expect(ids).toContain('taro-todo')
  })

  it("mode='none' + injection returns only the injected templates", () => {
    const injected: ProjectTemplate[] = [{ id: 'only', name: 'Only' }]
    expect(resolveTemplates(builtin, injected, 'none').map((t) => t.id)).toEqual([
      'only',
    ])
  })
})
