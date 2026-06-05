/**
 * `@dimina-kit/workbench/host` — the cross-process host-shell transport.
 *
 * These are the pieces a host-shell host (dimina-devtools' own `workbench()`
 * entry, which lives in `@dimina-kit/devtools` per the foundation's dependency
 * direction) constructs to carry `hostServices` (trusted-webview RPC) and
 * `events` (main→webview push) over a real Electron `ipcMain`:
 *
 *  - `WireTransport`            — the wire protocol (probe / invoke / event fanout)
 *  - `EventBus`                 — declared-event publisher fan-out
 *  - `InMemoryTypedIpcRegistry` — main-process handler/invoke registry the
 *                                 transport routes host/simulator kinds through
 *
 * The `workbench(config)` orchestration cannot live in this package without a
 * cycle (it must drive the devtools runtime, and devtools already depends on
 * `@dimina-kit/workbench`); exposing the transport here lets the devtools-side
 * entry assemble it. See packages/devtools/docs/workbench-model.md.
 */
export {
  WireTransport,
  type MinimalIpcMain,
  type MinimalWebContents,
  type WireTransportDeps,
} from '../internal/wire-transport.js'
export { EventBus } from '../internal/event-bus.js'
export { InMemoryTypedIpcRegistry } from '../internal/ipc-registry-memory.js'
/** Pure config validation (rejects malformed config before assembly). */
export { validateConfig } from '../workbench.js'
