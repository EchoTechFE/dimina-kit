# @dimina-kit/inspect

Host-agnostic runtime inspection for dimina mini-programs: WXML tree
extraction and Storage inspection. One package owns the protocol types, the
pure logic (Vue-runtime walk, stable-id registry, mutation-observing
inspector, storage-event reduction), the React panels, and the panels' data
wiring — so the Electron devtools and any downstream host (browser workbench,
preview iframe) share a single implementation and stay wire-compatible.

## Entry points

- `@dimina-kit/inspect` — core, zero runtime dependencies:
  - `WxmlNode` / `ElementInspection` — the wire-format types. Hosts transport
    them over IPC, `postMessage` or anything else.
  - `walkInstance(instance, depth)` — walks a mounted dimina render-layer Vue
    instance (`document.body.__vue_app__`) into a `WxmlNode` tree.
  - `registerSyntheticSid` / `findElementBySid` — stable element ids without
    writing `data-*` attributes into the page.
  - `createWxmlInspector(options)` — bundles the above into the surface a
    host injects into the render document: `getWxml()`,
    `highlightElement(sid)` (measure-only), `elementFor(sid)`,
    `setObserving(on)` (debounced `onMutated` callback while a panel is
    visible), `dispose()`.
  - `StorageItem` / `StorageEvent` / `StorageWriteResult` — the Storage
    wire-format types, plus `applyStorageEvent(items, evt)`, the pure
    reducer that folds a change feed into an item list.
- `@dimina-kit/inspect/panel` — the React layer (React ≥ 18 peer):
  - `WxmlPanel` / `StoragePanel` — the pure views (props in, no data wiring).
  - `ConnectedWxmlPanel` / `ConnectedStoragePanel` — the panels' data wiring,
    written once against their source contracts: seed on the
    (enabled && active) rising edge, live updates via the push subscription,
    visibility gating, hover inspection (WXML) / write forwarding (Storage).
    Hosts render them with their source implementation and never duplicate
    the wiring.
  - Styling uses Tailwind utility classes over CSS variables
    (`--color-code-blue`, `--color-surface-2`, …); the consuming app provides
    the Tailwind theme mapping and variable values, and must include this
    package's sources in its Tailwind content scan.
- `WxmlPanelSource` (main entry, type-only) — the five-operation transport
  contract behind the WXML panel: `getSnapshot` / `subscribe` / `setActive` /
  `inspect` / `clearInspection`. Each host implements only how these travel
  (Electron IPC channels, preview-iframe postMessage, …).
- `StoragePanelSource` (main entry, type-only) — the Storage counterpart:
  `getSnapshot` / `subscribe` / `setActive` / `setItem` / `removeItem` /
  `clear` / `clearAll?` / `getPrefix`. `clearAll` is optional — hosts whose
  storage partition is shared with non-mini-program data must omit it, and
  the panel then hides the origin-wide wipe entirely.

## Contract notes

- Every inspector method is read-only on the page. Visual highlighting is the
  host's job (CDP overlay, DOM overlay, …).
- `setObserving(true)` is only meant to be on while a WXML panel is visible —
  the tree walk is not free, so hosts gate it on panel visibility.
- After a render-document reload the injected realm (and its sid registry) is
  gone: the host must re-inject and re-push a full snapshot.
