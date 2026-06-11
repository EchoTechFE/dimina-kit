/**
 * panels decommission — public-type half (mirrors
 * workbench-config-header-height-deprecated.test.ts). The deprecated
 * `panels?: BuiltinPanelId[]` field must STAY on the public config type
 * (`WorkbenchConfig` / `WorkbenchAppConfig`) even though the runtime ignores
 * it, so downstream hosts that still pass it (e.g. `launch({ panels:
 * ['wxml'] })`) keep compiling.
 *
 * Real bug this catches: an over-eager implementer deletes the field from
 * `src/shared/types.ts` while removing the runtime plumbing — every
 * downstream `launch({ panels: [...], … })` becomes a TS compile error,
 * i.e. a breaking API change disguised as cleanup.
 *
 * GREEN today by design — this is the regression-guard side of the contract
 * (the field exists now and must continue to exist). The real gate is
 * compile-time: if the field is removed, this file fails to typecheck.
 */
import { describe, it, expect } from 'vitest'
import type { WorkbenchAppConfig, WorkbenchConfig } from './types.js'

describe('panels decommission: deprecated field stays on the public config type', () => {
  it("WorkbenchAppConfig still accepts panels: ['wxml'] (deprecated, runtime-ignored)", () => {
    // Compile-time assertion: this assignment must typecheck without casts.
    const cfg: WorkbenchAppConfig = { panels: ['wxml'] }
    expect(cfg.panels).toEqual(['wxml'])
  })

  it('WorkbenchConfig still accepts panels and keeps it optional', () => {
    const withField: WorkbenchConfig = { panels: ['wxml', 'console'] }
    const withoutField: WorkbenchConfig = {}
    expect(withField.panels).toEqual(['wxml', 'console'])
    expect(withoutField.panels).toBeUndefined()
  })
})
