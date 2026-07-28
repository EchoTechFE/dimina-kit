# @dimina-kit/inspect

Host-agnostic runtime inspection for dimina mini-programs: WXML tree
extraction, Storage inspection, AppData (page `setData` state) and the 编译
(compile) timeline. One package owns the protocol types, the pure logic
(Vue-runtime walk, stable-id registry, mutation-observing inspector,
storage-event reduction, setData accumulation), the React panels, and the
panels' data wiring — so the Electron devtools and any downstream host
(browser workbench, preview iframe) share a single implementation and stay
wire-compatible.

## Entry points

- `@dimina-kit/inspect` — core (no runtime dependencies; the JSON tree viewer
  is pulled in by the `/panel` entry only):
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
  - `AppDataAccumulator` + `decodeWorkerMessage` / `decodeOutgoingMessage` /
    `decodedToInput` — the cumulative per-(bridge, module) `setData` state
    behind the AppData panel. Hosts tap the dimina service→render message
    stream wherever they can reach it (an Electron preload sniffing Worker
    `message` events, a same-origin workbench observing the pageFrame's
    Worker) and feed this one accumulator, so the decode/merge/page-only
    policy can't drift between hosts. `AppDataSnapshot` is the wire format.
  - `CompileEvent` / `CompileLogEntry` — the 编译 panel's two feed item
    shapes (status transitions and per-line compiler output).
- `@dimina-kit/inspect/panel` — the React layer (React ≥ 18 peer):
  - `WxmlPanel` / `StoragePanel` / `AppDataPanel` / `CompilePanel` — the pure
    views (props in, no data wiring).
  - `ConnectedWxmlPanel` / `ConnectedStoragePanel` / `ConnectedAppDataPanel` /
    `ConnectedCompilePanel` — the panels' data wiring, written once against
    their source contracts: seed on the (enabled && active) rising edge, live
    updates via the push subscription, visibility gating, plus the
    panel-specific parts — hover inspection (WXML), write forwarding
    (Storage), Pages-sidebar auto-follow of the active page plus `setData`
    edit write-back when the source provides `setData` (AppData), FIFO caps
    and arrival-order `seq` stamping (编译). Hosts render them with their
    source implementation and never duplicate the wiring.
  - Styling uses Tailwind utility classes over CSS variables
    (`--color-code-blue`, `--color-surface-2`, …); the consuming app provides
    the Tailwind theme mapping and variable values, and must include this
    package's sources in its Tailwind content scan.
  - The panels fill their host: their roots use `flex-1` / `h-full`, and
    AppData's kept-alive per-page trees are `absolute inset-0`. The host must
    mount them inside a sized flex container (`height: 100%; display: flex;
    flex-direction: column`) — in a plain unsized block the AppData content
    collapses to zero height and the panel reads as blank.
- `WxmlPanelSource` (main entry, type-only) — the five-operation transport
  contract behind the WXML panel: `getSnapshot` / `subscribe` / `setActive` /
  `inspect` / `clearInspection`. Each host implements only how these travel
  (Electron IPC channels, preview-iframe postMessage, …).
- `StoragePanelSource` (main entry, type-only) — the Storage counterpart:
  `getSnapshot` / `subscribe` / `setActive` / `setItem` / `removeItem` /
  `clear` / `clearAll?` / `getPrefix`. `clearAll` is optional — hosts whose
  storage partition is shared with non-mini-program data must omit it, and
  the panel then hides the origin-wide wipe entirely.
- `AppDataPanelSource` (main entry, type-only) — the AppData counterpart:
  `getSnapshot` / `subscribe` / `setActive`. Pushes carry the FULL cumulative
  `AppDataSnapshot` (merging patches is the producer-side accumulator's job).
- `CompilePanelSource` (main entry, type-only) — the 编译 counterpart:
  `getSnapshot` / `subscribe` / `setActive` / `clear?`. The subscription
  pushes `CompileFeedEvent`s (`event` / `log` appends or a host-side
  `reset`); the connected panel owns the FIFO caps (200 events / 300 logs)
  and stamps a shared monotonic `seq` onto unstamped arrivals so same-`at`
  ties keep arrival order in the merged timeline.

## Contract notes

- Every inspector method is read-only on the page. Visual highlighting is the
  host's job (CDP overlay, DOM overlay, …).
- `setObserving(true)` is only meant to be on while a WXML panel is visible —
  the tree walk is not free, so hosts gate it on panel visibility.
- After a render-document reload the injected realm (and its sid registry) is
  gone: the host must re-inject and re-push a full snapshot.
