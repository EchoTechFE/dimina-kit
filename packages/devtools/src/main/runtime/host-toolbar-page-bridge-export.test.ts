/**
 * Feedback fix ⑥ — the page-side bridge needs a PUBLIC type declaration.
 *
 * Today's gap, verified against source: the framework injects
 * `window.diminaHostToolbar` (src/preload/runtime/host-toolbar-port.ts,
 * BRIDGE_KEY) and host-migration.md tells toolbar pages to call
 * `window.diminaHostToolbar.send/onMessage` — but no exported type and no
 * `Window` augmentation exist anywhere in the package. Every TypeScript
 * toolbar page re-declares the bridge by hand (and drifts).
 *
 * Locked contract (this file is the spec):
 *  - export `DiminaHostToolbarPageBridge` from the public barrel
 *    `src/main/api.ts` (package export "."); the definition should live on an
 *    electron-free module (the miniapp-runtime contract module is the natural
 *    home) so non-Electron page code can import it.
 *  - shape mirrors the injected bridge EXACTLY (host-toolbar-port.ts):
 *      send(channel: string, payload: unknown): void
 *      onMessage(channel: string, handler: (payload: unknown) => void): () => void
 *    (page-side onMessage returns a bare un-subscribe FUNCTION — unlike the
 *    main-side control's `{ dispose }` — because that is what the preload
 *    actually exposes; declaring `{ dispose }` here would be a lie.)
 *  - a `declare global { interface Window { diminaHostToolbar?: … } }`
 *    augmentation ships with it, OPTIONAL because the bridge only exists
 *    inside the toolbar WCV with a passing runtime guard.
 *
 * RED / flip protocol: the original `@ts-expect-error RED` markers flipped
 * when the fix landed and were deleted per protocol — the remaining lines
 * are the permanent compile-time guards.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function staticAssert<_T extends true>(): void {}

/**
 * The injected bridge's exact shape, transcribed from
 * src/preload/runtime/host-toolbar-port.ts `contextBridge.exposeInMainWorld`.
 */
type ExpectedBridge = {
  send: (channel: string, payload: unknown) => void
  onMessage: (channel: string, handler: (payload: unknown) => void) => () => void
}

// ═════════════════════════════════════════════════════════════════════════
// §1 The named export must exist on the public barrel.
// ═════════════════════════════════════════════════════════════════════════

type ActualBridge = import('../api.js').DiminaHostToolbarPageBridge
const _barrelTypePin: ActualBridge | undefined = undefined
void _barrelTypePin

// ═════════════════════════════════════════════════════════════════════════
// §2 Shape pins (mutual assignability with the transcribed preload shape).
// Real bug caught (post-flip): the declared type drifting from what the
// preload actually injects — e.g. onMessage declared to return { dispose }
// while the real bridge returns a bare function.
// ═════════════════════════════════════════════════════════════════════════

// Both directions are vacuously green today (ActualBridge resolves to the
// suppressed error-any) and become REAL constraints the moment the export
// exists — keep unmarked; they are the permanent shape guards.
staticAssert<ActualBridge extends ExpectedBridge ? true : false>()
staticAssert<ExpectedBridge extends ActualBridge ? true : false>()

// ═════════════════════════════════════════════════════════════════════════
// §3 The global Window augmentation: toolbar page code written against this
// package's types can use `window.diminaHostToolbar` without a hand-rolled
// declaration. Optional — the bridge exists only in guarded toolbar WCVs.
// ═════════════════════════════════════════════════════════════════════════

type WindowBridgeSlot = Window['diminaHostToolbar']
// Vacuously green today (WindowBridgeSlot resolves to the suppressed
// error-any); REAL constraints post-flip — keep unmarked. The second pin
// forces the augmentation to declare the property OPTIONAL (`undefined`
// must stay in the slot: the bridge only exists in guarded toolbar WCVs).
staticAssert<WindowBridgeSlot extends ExpectedBridge | undefined ? true : false>()
staticAssert<undefined extends WindowBridgeSlot ? true : false>()

// ═════════════════════════════════════════════════════════════════════════
// §4 Runtime assertion (vitest-RED today).
// ═════════════════════════════════════════════════════════════════════════

const thisTestFile = import.meta.url.startsWith('file:')
  ? fileURLToPath(import.meta.url)
  : import.meta.url
const barrelSourcePath = path.join(path.dirname(thisTestFile), '..', 'api.ts')

describe('feedback ⑥ — DiminaHostToolbarPageBridge public declaration', () => {
  it('the public barrel (src/main/api.ts) exports DiminaHostToolbarPageBridge [RED today]', () => {
    // Real bug: host-migration.md instructs pages to call
    // window.diminaHostToolbar.send/onMessage, but the package ships no type
    // for it — every TS toolbar page hand-rolls (and drifts from) the shape.
    const source = readFileSync(barrelSourcePath, 'utf8')
    expect(
      /DiminaHostToolbarPageBridge/.test(source),
      'src/main/api.ts must re-export the DiminaHostToolbarPageBridge type',
    ).toBe(true)
  })
})
