/**
 * `@dimina-kit/electron-deck/host` — the cross-process host-shell transport.
 *
 * These are the pieces a host-shell host (dimina-devtools' own `electronDeck()`
 * entry, which lives in `@dimina-kit/devtools` per the foundation's dependency
 * direction) constructs to carry `hostServices` (trusted-webview RPC) and
 * `events` (main→webview push) over a real Electron `ipcMain`:
 *
 *  - `WireTransport`            — the wire protocol (probe / invoke / event fanout)
 *  - `EventBus`                 — declared-event publisher fan-out
 *  - `InMemoryTypedIpcRegistry` — main-process handler/invoke registry the
 *                                 transport routes host/simulator kinds through
 *
 * The `electronDeck(config)` orchestration cannot live in this package without a
 * cycle (it must drive the devtools runtime, and devtools already depends on
 * `@dimina-kit/electron-deck`); exposing the transport here lets the devtools-side
 * entry assemble it. See packages/devtools/docs/workbench-model.md.
 */
export {
  WireTransport,
  type InvokeCtx,
  type MinimalIpcMain,
  type MinimalWebContents,
  type WireTransportDeps,
} from '../internal/wire-transport.js'
export { EventBus } from '../internal/event-bus.js'
export { InMemoryTypedIpcRegistry } from '../internal/ipc-registry-memory.js'
/**
 * Domain-neutral facade (`command` / `event` / `trust`) over the wire + bus +
 * trust set, plus the refcount trust-set primitive it depends on.
 */
export {
  createControlBus,
  type ControlBus,
  type ControlBusEventHandle,
  type CreateControlBusDeps,
} from './control-bus.js'
export { createTrustSet, type TrustSet, type TrustIndex } from '../internal/trust-set.js'
/**
 * P4 Phase B — capability grant registry + policy (the privileged-command gate).
 */
export {
  createCapabilityRegistry,
  type CapabilityPolicy,
  type Grant,
} from './capability.js'
/** Pure config validation (rejects malformed config before assembly). */
export { validateConfig } from '../electron-deck.js'
/**
 * Backend-facing types. `RuntimeBackend` / `TrustedSenderRef` also flow through
 * the root entry (`@dimina-kit/electron-deck`); re-exported here so a backend
 * implementer has one import site alongside the transport pieces.
 */
export type { MinimalApp } from '../internal/electron-types.js'
export type { RuntimeBackend, TrustedSenderRef } from '../types.js'
