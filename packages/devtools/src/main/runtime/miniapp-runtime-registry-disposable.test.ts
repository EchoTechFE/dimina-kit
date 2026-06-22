/**
 * Disposal-idiom consistency on the contract's `registry.add`.
 *
 *  - The REAL registry behind `ctx.registry` is
 *    `DisposableRegistry` from `@dimina-kit/electron-deck/main`
 *    (packages/electron-deck/src/main/disposable.ts) — its `add` accepts
 *    `Disposable | DisposeFn` and has runtime tests for both forms.
 *  - The `MiniappRuntime` contract narrows it to
 *    `add: (dispose: () => void) => unknown` — a host holding the contract
 *    CANNOT register the `{ dispose }` objects the rest of this very surface
 *    hands out (`hostToolbar.onMessage(...)` returns a Disposable!), forcing
 *    the awkward `registry.add(() => sub.dispose())` wrapper everywhere.
 *
 * Locked contract: the contract's `registry.add` accepts BOTH forms —
 * `{ dispose(): void } | (() => void)` — matching the live implementation.
 *
 * type-level gap; the runtime suite is a GREEN devtools-side pin of the
 * electron-deck behavior the widened contract relies on (the indictment is
 * type-only — runtime already conforms).
 */
import { describe, expect, it, vi } from 'vitest'
import { DisposableRegistry } from '@dimina-kit/electron-deck/main'
import type { MiniappRuntime } from './miniapp-runtime.js'

// ═════════════════════════════════════════════════════════════════════════
// §1 Type-level: the contract must accept the Disposable OBJECT form.
// Real bug caught (post-flip): the contract regresses to fn-only and every
// host registering a returned subscription (`registry.add(sub)`) breaks.
// ═════════════════════════════════════════════════════════════════════════

function _registryAddConsumptionPin(rt: MiniappRuntime): void {
  // The fn form — today's only sanctioned shape; must KEEP compiling.
  rt.registry.add(() => {})

  // The Disposable-object form — what hostToolbar.onMessage returns.
  const sub: { dispose: () => void } = { dispose: () => {} }
  rt.registry.add(sub)
}
void _registryAddConsumptionPin

// ═════════════════════════════════════════════════════════════════════════
// §2 Runtime: the live registry honors both idioms (green pin — this is the
// behavior the widened contract type advertises, owned by electron-deck's
// DisposableRegistry, which `createWorkbenchContext` instantiates directly).
// ═════════════════════════════════════════════════════════════════════════

describe('feedback ④ — registry.add accepts both disposal idioms at runtime', () => {
  it('registers a bare () => void and invokes it on disposeAll', async () => {
    const registry = new DisposableRegistry()
    const fnForm = vi.fn()

    registry.add(fnForm)
    await registry.disposeAll()

    expect(fnForm).toHaveBeenCalledTimes(1)
  })

  it('registers a { dispose } object and invokes its dispose on disposeAll', async () => {
    // BUG CAUGHT (had runtime matched the narrow contract type): a host's
    // `registry.add(subscription)` would silently register a no-op and leak
    // the subscription on teardown.
    const registry = new DisposableRegistry()
    const objForm = vi.fn()

    registry.add({ dispose: objForm })
    await registry.disposeAll()

    expect(objForm).toHaveBeenCalledTimes(1)
  })

  it('both forms registered together each fire exactly once, and a handle.dispose() releases early', async () => {
    const registry = new DisposableRegistry()
    const fnForm = vi.fn()
    const objForm = vi.fn()

    registry.add(fnForm)
    const handle = registry.add({ dispose: objForm })

    handle.dispose()
    expect(objForm).toHaveBeenCalledTimes(1)

    await registry.disposeAll()
    expect(fnForm).toHaveBeenCalledTimes(1)
    // Early-released entry must not double-fire on the sweep.
    expect(objForm).toHaveBeenCalledTimes(1)
  })
})
