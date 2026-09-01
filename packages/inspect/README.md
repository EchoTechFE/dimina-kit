# @dimina-kit/inspect

> The debugging panels behind Dimina DevTools — WXML tree, Storage, AppData and
> the compile timeline — packaged so any host can render them.

The Electron devtools, a browser workbench and a preview iframe all inspect a
running mini-app in the same way, and it would be a waste for each of them to
reimplement the tree walk, the storage reducer and the `setData` merge policy.
This package owns all of it: the wire-format types, the pure logic, the React
panels, and the panels' data wiring. Hosts supply only *transport* — how the
data travels between the page being inspected and the panel.

## Install

```bash
pnpm add @dimina-kit/inspect
```

React (≥ 18) is an optional peer dependency, needed only for the `/panel`
entry. The core entry has no runtime dependencies.

## How a host wires this up

1. Inject `createWxmlInspector()` into the render document — that gives you
   `getWxml()`, `elementFor(sid)`, mutation observation, and so on.
2. Implement the matching source contract (`WxmlPanelSource`,
   `StoragePanelSource`, `AppDataPanelSource`, `CompilePanelSource`). Each is a
   small set of operations; you decide how they travel (Electron IPC,
   `postMessage`, …).
3. Render the corresponding `Connected*Panel` with that source. The panel
   handles seeding, live updates, visibility gating and caps itself.

## Core entry: `@dimina-kit/inspect`

No runtime dependencies (the JSON tree viewer is pulled in by `/panel` only).

**WXML**

- `WxmlNode` / `ElementInspection` — the wire-format types. Hosts transport them
  over IPC, `postMessage` or anything else.
- `walkInstance(instance, depth)` — walks a mounted dimina render-layer Vue
  instance (`document.body.__vue_app__`) into a `WxmlNode` tree.
- `registerSyntheticSid` / `findElementBySid` — stable element ids without
  writing `data-*` attributes into the page.
- `createWxmlInspector(options)` — bundles the above into the surface a host
  injects into the render document: `getWxml()`, `highlightElement(sid)`
  (measure-only), `elementFor(sid)`, `setObserving(on)` (debounced `onMutated`
  callback while a panel is visible), `dispose()`.

**Storage**

- `StorageItem` / `StorageEvent` / `StorageWriteResult` — the wire-format types,
  plus `applyStorageEvent(items, evt)`, the pure reducer that folds a change
  feed into an item list.

**AppData**

- `AppDataAccumulator` + `decodeWorkerMessage` / `decodeOutgoingMessage` /
  `decodedToInput` — the cumulative per-(bridge, module) `setData` state behind
  the AppData panel. Hosts tap the dimina service→render message stream wherever
  they can reach it (an Electron preload sniffing Worker `message` events, a
  same-origin workbench observing the pageFrame's Worker) and feed this one
  accumulator, so the decode/merge/page-only policy can't drift between hosts.
  `AppDataSnapshot` is the wire format.

**编译 (compile)**

- `CompileEvent` / `CompileLogEntry` — the panel's two feed item shapes (status
  transitions and per-line compiler output).

## React entry: `@dimina-kit/inspect/panel`

- `WxmlPanel` / `StoragePanel` / `AppDataPanel` / `CompilePanel` — the pure
  views (props in, no data wiring).
- `ConnectedWxmlPanel` / `ConnectedStoragePanel` / `ConnectedAppDataPanel` /
  `ConnectedCompilePanel` — the data wiring, written once against the source
  contracts: seed on the (enabled && active) rising edge, live updates via the
  push subscription, visibility gating, plus the panel-specific parts — hover
  inspection (WXML), write forwarding (Storage), Pages-sidebar auto-follow of
  the active page and `setData` edit write-back when the source provides
  `setData` (AppData), FIFO caps and arrival-order `seq` stamping (编译). Render
  these with your source implementation and never duplicate the wiring.

Two things the host must provide:

- **Tailwind theme.** Styling uses Tailwind utility classes over CSS variables
  (`--color-code-blue`, `--color-surface-2`, …). The consuming app provides the
  variable values and must include this package's sources in its Tailwind
  content scan.
- **A sized container.** The panels fill their host: roots use `flex-1` /
  `h-full`, and AppData's kept-alive per-page trees are `absolute inset-0`. Mount
  them inside `height: 100%; display: flex; flex-direction: column`. In a plain
  unsized block the AppData content collapses to zero height and the panel reads
  as blank.

## Source contracts (type-only, from the main entry)

- `WxmlPanelSource` — `getSnapshot` / `subscribe` / `setActive` / `inspect` /
  `clearInspection`.
- `StoragePanelSource` — `getSnapshot` / `subscribe` / `setActive` / `setItem` /
  `removeItem` / `clear` / `clearAll?` / `getPrefix`. `clearAll` is optional:
  hosts whose storage partition is shared with non-mini-program data must omit
  it, and the panel then hides the origin-wide wipe entirely.
- `AppDataPanelSource` — `getSnapshot` / `subscribe` / `setActive`. Pushes carry
  the FULL cumulative `AppDataSnapshot`; merging patches is the producer-side
  accumulator's job.
- `CompilePanelSource` — `getSnapshot` / `subscribe` / `setActive` / `clear?`.
  The subscription pushes `CompileFeedEvent`s (`event` / `log` appends or a
  host-side `reset`); the connected panel owns the FIFO caps (200 events / 300
  logs) and stamps a shared monotonic `seq` onto unstamped arrivals so same-`at`
  ties keep arrival order in the merged timeline.

## Contract notes

- Every inspector method is read-only on the page. Visual highlighting is the
  host's job (CDP overlay, DOM overlay, …).
- `setObserving(true)` is only meant to be on while a WXML panel is visible —
  the tree walk is not free, so hosts gate it on panel visibility.
- After a render-document reload the injected realm (and its sid registry) is
  gone: the host must re-inject and re-push a full snapshot.

## License

[MIT](../../LICENSE) © EchoTechFE
