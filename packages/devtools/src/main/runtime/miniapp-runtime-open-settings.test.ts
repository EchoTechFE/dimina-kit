/**
 * The contract exposes a first-class `openSettings()` instead of a `windows`
 * pass-through (which was unfulfillable):
 *  - `MiniappRuntime.windows` would be documented as "Pass it through to framework
 *    helpers (e.g. `openSettingsWindow`)" — but `openSettingsWindow`
 *    (src/main/app/launch.ts) requires
 *    `Pick<WorkbenchContext, 'rendererDir' | 'notify' | 'windows'>`:
 *    a real `WindowService` and a full `RendererNotifier`. The contract's
 *    `windows: object` and `notify: { projectStatus }` can NEVER satisfy that
 *    Pick — a host holding only `MiniappRuntime` cannot call the one helper
 *    `windows` exists for.
 *
 * Locked contract (this file is the spec):
 *  - `WorkbenchContext` gains `openSettings: () => Promise<void>`, wired by
 *    the app/launch assembly to the real `openSettingsWindow` path (runtime
 *    proof lives in src/main/app/open-settings-wiring.test.ts).
 *  - `MiniappRuntime` gains `openSettings: () => Promise<void>` and DROPS
 *    `windows` and `rendererDir` (both existed only for that pass-through;
 *    a downstream host's real rendererDir need is served by the `/paths` export).
 *  - `asMiniappRuntime` stays an identity return and the assignment-compat
 *    sentinel keeps compiling.
 *
 * The remaining `@ts-expect-error` lines are permanent compile-time guards.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { MiniappRuntime } from './miniapp-runtime.js'

// ── type-level helpers ──────────────────────────────────────────────────────
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false
type Not<B extends boolean> = B extends true ? false : true
function staticAssert<_T extends true>(): void {}

// ═════════════════════════════════════════════════════════════════════════
// §1 Members gained. Real bug caught: `openSettings` drops off
// either surface and hosts lose their only sanctioned way to open settings.
// ═════════════════════════════════════════════════════════════════════════

staticAssert<HasKey<MiniappRuntime, 'openSettings'>>()

staticAssert<HasKey<WorkbenchContext, 'openSettings'>>()

// Exact call shape a host uses (compile-only).
function _openSettingsConsumptionPin(rt: MiniappRuntime, ctx: WorkbenchContext): void {
  const fromContract: Promise<void> = rt.openSettings()
  const fromContext: Promise<void> = ctx.openSettings()
  void fromContract
  void fromContext
}
void _openSettingsConsumptionPin

// ═════════════════════════════════════════════════════════════════════════
// §2 Members lost. Real bug caught: re-adding `windows` /
// `rendererDir` re-promises a pass-through that types can't honor (windows)
// or duplicates the /paths export (rendererDir).
// ═════════════════════════════════════════════════════════════════════════

staticAssert<Not<HasKey<MiniappRuntime, 'windows'>>>()

staticAssert<Not<HasKey<MiniappRuntime, 'rendererDir'>>>()

// ═════════════════════════════════════════════════════════════════════════
// §3 The identity / assignment-compat sentinel must KEEP compiling: a real
// WorkbenchContext (now carrying openSettings) still satisfies the contract
// by plain assignment, so `asMiniappRuntime` stays `return ctx`.
// ═════════════════════════════════════════════════════════════════════════

const _contextStillSatisfiesContract: (ctx: WorkbenchContext) => MiniappRuntime = (ctx) => ctx
void _contextStillSatisfiesContract

// ═════════════════════════════════════════════════════════════════════════
// §4 Runtime assertions.
// ═════════════════════════════════════════════════════════════════════════

const thisTestFile = import.meta.url.startsWith('file:')
  ? fileURLToPath(import.meta.url)
  : import.meta.url
const contractSourcePath = path.join(path.dirname(thisTestFile), 'miniapp-runtime.ts')

describe('feedback ② — MiniappRuntime.openSettings replaces the dead windows pass-through', () => {
  it('the contract module declares openSettings', () => {
    // Real bug: the contract ships an opaque `windows: object` whose ONLY
    // documented purpose (`openSettingsWindow(ctx)`) cannot typecheck against
    // openSettingsWindow's Pick<…,'rendererDir'|'notify'|'windows'> — a
    // MiniappRuntime-only host has no way to open the settings window.
    const source = readFileSync(contractSourcePath, 'utf8')
    expect(
      /\bopenSettings\b/.test(source),
      'miniapp-runtime.ts must declare openSettings: () => Promise<void> on the MiniappRuntime contract',
    ).toBe(true)
  })

  it('the contract module no longer carries the windows opaque handle', () => {
    // `windows` existed solely for the unfulfillable pass-through; with
    // openSettings on the contract it must go (先窄后宽 — re-adding is a
    // deliberate semver decision).
    const source = readFileSync(contractSourcePath, 'utf8')
    expect(
      /^\s*windows:\s*object/m.test(source),
      'miniapp-runtime.ts must drop the `windows: object` member from MiniappRuntime',
    ).toBe(false)
  })
})
