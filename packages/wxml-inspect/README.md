# @dimina-kit/wxml-inspect

Host-agnostic WXML tree extraction and inspection for dimina render layers.
One package owns the protocol types, the Vue-runtime walk, the stable-id
registry, the mutation-observing inspector, and the React tree panel — so the
Electron devtools and any downstream host (browser workbench, preview iframe)
share a single implementation and stay wire-compatible.

## Entry points

- `@dimina-kit/wxml-inspect` — core, zero runtime dependencies:
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
- `@dimina-kit/wxml-inspect/panel` — the React layer (React ≥ 18 peer):
  - `WxmlPanel` — the pure tree view (props in, no data wiring).
  - `ConnectedWxmlPanel` — the panel's data wiring, written once against
    `WxmlPanelSource`: seed on the (enabled && active) rising edge, live
    updates via the push subscription, visibility gating, hover inspection.
    Hosts render it with their source implementation and never duplicate the
    wiring.
  - Styling uses Tailwind utility classes over CSS variables
    (`--color-code-blue`, `--color-surface-2`, …); the consuming app provides
    the Tailwind theme mapping and variable values, and must include this
    package's sources in its Tailwind content scan.
- `WxmlPanelSource` (main entry, type-only) — the five-operation transport
  contract behind the panel: `getSnapshot` / `subscribe` / `setActive` /
  `inspect` / `clearInspection`. Each host implements only how these travel
  (Electron IPC channels, preview-iframe postMessage, …).

## Contract notes

- Every inspector method is read-only on the page. Visual highlighting is the
  host's job (CDP overlay, DOM overlay, …).
- `setObserving(true)` is only meant to be on while a WXML panel is visible —
  the tree walk is not free, so hosts gate it on panel visibility.
- After a render-document reload the injected realm (and its sid registry) is
  gone: the host must re-inject and re-push a full snapshot.
