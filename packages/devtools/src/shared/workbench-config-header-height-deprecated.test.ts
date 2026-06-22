/**
 * The deprecated `headerHeight?: number` field must STAY on the public config
 * type (`WorkbenchConfig` / `WorkbenchAppConfig`) even though the runtime
 * ignores it, so downstream hosts that still pass it (e.g.
 * e2e/extension-host-entry.js) keep compiling.
 *
 * Real bug this catches: deleting the field from `src/shared/types.ts` while
 * removing the runtime plumbing turns every downstream
 * `launch({ headerHeight: 72, … })` into a TS compile error — a breaking API
 * change disguised as cleanup.
 *
 * The gate is compile-time: if the field is removed, this file fails to
 * typecheck.
 */
import { describe, it, expect } from 'vitest'
import type { WorkbenchAppConfig, WorkbenchConfig } from './types.js'

describe('headerHeight decommission: deprecated field stays on the public config type', () => {
  it('WorkbenchAppConfig still accepts headerHeight (deprecated, runtime-ignored)', () => {
    // Compile-time assertion: this assignment must typecheck without casts.
    const cfg: WorkbenchAppConfig = { headerHeight: 72 }
    expect(cfg.headerHeight).toBe(72)
  })

  it('WorkbenchConfig still accepts headerHeight and keeps it optional', () => {
    const withField: WorkbenchConfig = { headerHeight: 40 }
    const withoutField: WorkbenchConfig = {}
    expect(withField.headerHeight).toBe(40)
    expect(withoutField.headerHeight).toBeUndefined()
  })
})
