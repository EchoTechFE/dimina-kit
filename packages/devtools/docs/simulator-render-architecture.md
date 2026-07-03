# Native-host simulator rendering architecture (DeviceShell / WCV bounds / zoom)

native-host is the SOLE simulator runtime. The simulator is a top-level
`WebContentsView` (WCV) overlaid on the simulator dock panel's region of the
main-window React renderer — a native overlay, exactly like the Chromium
DevTools view. This doc describes who draws the phone, how the WCV is sized, and
how zoom flows.

## The model in one paragraph

The renderer's `<SimulatorPanel>` draws **NO** phone and **NO** bezel — only a
toolbar, an EMPTY flex:1 placeholder div, and a page-path bar. The simulator WCV
is overlaid on exactly that placeholder region. Inside the WCV,
`simulator.html` → `SimulatorApp` (`src/simulator/simulator-app.tsx`) →
**`DeviceShell` draws the WHOLE phone** (rounded corners, notch, status bar,
nav-bar, page viewport, tab-bar, home-indicator) at FIXED device-logical size,
on a gray "desk" that fills the WCV and **scrolls natively** when the phone is
larger than the region. The WCV is a plain rectangle with no native corner
radius — its own web-viewport is the (straight-edged) clip. The page itself is
a render-host `<webview>` guest nested inside the DeviceShell.

## Recompile = soft reload (ready-then-swap), not a WCV rebuild

A watcher rebuild does NOT tear the WCV down. The renderer asks main to
soft-reload (`SimulatorChannel.SoftReload`); when the shell is live+ready main
forwards `SIMULATOR_EVENTS.RELAUNCH {url}` into the WCV, and `SimulatorApp`
boots a SECOND app session whose DeviceShell mounts invisibly
(`visibility:hidden` — `display:none` would keep its `<webview>` guest from
attaching) next to the live one. When the new session's root page reports
`DOM_READY` the two swap in a single React commit and the old session is
disposed; a session that never becomes ready is dropped after
`SOFT_RELOAD_TIMEOUT_MS` and the live shell stays. During the overlap BOTH
shells receive every `SIMULATOR_EVENTS` broadcast, so session-scoped events
(API_CALL / NAV_ACTION / TAB_ACTION) are subscribed through
`SimulatorMiniApp.onSessionEvent`, which drops payloads naming another
`appSessionId`. Shell wrappers render in boot order and surviving nodes never
move in the DOM — a moved `<webview>` re-attaches and reloads its guest. The
hard path (`attachNativeSimulator`, full teardown + rebuild) remains the
fallback when main reports no live+ready shell, and the only path for project
open/close and device relaunch.

### Leak guards on the churn cycle

Coarse memory sampling can't see a leaked listener or a stale map entry, so
resource coverage is count-based. The bridge router owns every session ledger
(RouterState) and therefore also exposes the census — `BridgeRouterHandle.census()`,
published to e2e as the NODE_ENV=test main-process global
`__diminaResourceCensus`. Three layers consume it:

- `src/main/ipc/bridge-router-census.test.ts` — unit: ledger shape + exact
  return-to-baseline across spawn → dispose.
- `e2e/soft-reload-census.spec.ts` — default suite, real Electron: 5 real
  recompiles (round-unique marker must render) then the ledger, the shell wc
  id and the webContents population must return exactly to baseline; closing
  the project must return the ledger to the pre-open snapshot.
- `e2e/hot-reload-stress.spec.ts` — manual-only (`HOT_RELOAD_STRESS=1`):
  30-round memory-trend + webContents-count backstop for what counting can't
  price (heap growth).

Independently, the fixtures' auto `_maxListenersGate` fails any fixture-based
test during which the app printed `MaxListenersExceededWarning` on stderr
(`e2e/resource-guards.ts`) — the one-dead-listener-per-cycle class surfaces as
a hard failure instead of log noise.

```
renderer (z2)          SimulatorPanel: toolbar / flex:1 placeholder / path-bar
   │  createPlacementAnchor publishes the placeholder rect (+ zoom)
   ▼
simulator WCV (z3)     simulator.html → DeviceShell
   │                     • gray desk (.device-shell-root) fills WCV, scrolls
   │                     • phone (.device-shell) FIXED device size, radius 38,
   │                       notch, status/nav/tab/home chrome
   ▼
render-host <webview>  the page (one guest per mounted page, z-ordered by visibility)
```

## Who draws what (DeviceShell owns the phone)

- **Renderer (`simulator-panel.tsx`)** — draws the toolbar (device / zoom
  selects), an empty `flex:1` placeholder div (`data-area="native-simulator"`),
  and the page-path bar. The panel comment is explicit: "this z2 renderer panel
  draws NO phone/bezel." It owns the `createPlacementAnchor` that binds the WCV to
  the placeholder rect.
- **DeviceShell (`src/simulator/device-shell/`, runs INSIDE the WCV)** — draws
  the whole phone. `.device-shell-root` is the gray desk (`width:100%`,
  `height:100vh`, `overflow:auto`, `padding:24`, mirrors the renderer's
  `--color-sim-bg` so the resize-follow gap is invisible). `.device-shell` is the
  phone: FIXED device-logical `width`/`height` (set inline from the device),
  `border-radius:38`, border + shadow, `margin:auto` to center when it fits and
  stay top-left-scrolled when it overflows, `flex:none` so it never squishes with
  the WCV. Status bar / notch / nav-bar / page `<webview>` / tab-bar /
  home-indicator are children of `.device-shell`.
- **render-host `<webview>` guests** — the actual pages, one per mounted page
  entry, rendered inside `.device-shell__viewport` and z-ordered by `display` +
  `zIndex` on visibility. These are LIVE — they are the page WebContents.

This is the **DeviceShell-draws-the-phone** model: the renderer panel draws no
bezel. It matches `docs/simulator-render-stack.html` (z3 = the WCV = the flex:1
region; the phone is fixed-size CSS inside it).

## WCV bounds — single authority

The WCV bounds come from a **single authority**: the renderer's `createPlacementAnchor`
in `simulator-panel.tsx` measures the placeholder region's
`getBoundingClientRect()` and publishes it (plus `zoom`) over
`simulator:set-native-bounds` → `setNativeSimulatorViewBounds`
(`view-manager.ts`). There is no second, coarse panel-width path competing with
it.

- **Zero-area ⇒ detach-but-keep-alive.** `{ width:0, height:0 }` removes the WCV
  from the contentView but keeps its WebContents, so re-showing is cheap (same
  policy as the DevTools overlay).
- **Pre-attach caching.** A report can land before `attachNativeSimulator` (the
  project-open ordering); `view-manager` caches the last rect and replays it on
  attach (`setNativeSimulatorViewBounds(lastRendererRect)`), adding + sizing the
  WCV. If the cached rect is zero, the WCV stays unattached until the next report.
- **Region rect, not inner-screen.** The renderer publishes the placeholder
  REGION rect (the flex:1 slot). The WCV fills that region as a plain rectangle;
  DeviceShell draws + scrolls the phone inside. There is no renderer bezel to
  measure.

## zoom

`zoom` (percent) rides the same `publish` so its identity changes with zoom,
re-publishing on change. Main applies it as the WCV's `zoomFactor` (`zoom/100`)
in `setNativeSimulatorViewBounds`, scaling the nested render-host page. zoom is
NEVER a CSS transform in the renderer panel.

## ViewAnchor binding

The simulator uses the shared, tested `view-anchor` primitive
(`packages/view-anchor/`) — the same package that backs the Chromium DevTools
(`console`) overlay. `SimulatorPanel` is a DOM dock panel (it renders its own
device/zoom chrome — a bare `NativeSlot` would render no chrome), and it OWNS the
simulator-WCV anchor itself on its `data-area="native-simulator"` placeholder
div. The simulator's anchor:

- **Imperative `createPlacementAnchor`, NOT the React `useViewAnchor`.** The
  simulator dock leaf is pinned to `fixedPx`, so dragging an ADJACENT splitter
  SHIFTS its x-position WITHOUT resizing it — a `ResizeObserver` never fires.
  `followGeometry: true` opens a windowed-RAF geometry sentinel that re-publishes
  the moved rect frame-by-frame. The ref-callback binds on mount, rebinds without
  a hidden flash on element swap, and publishes-hidden-then-disposes on unmount.
- **Unmount = collapse.** When the simulator panel is closed/inactive `<DockView>`
  unmounts `SimulatorPanel`; the ref-callback `null` cleanup (and a hard-unmount
  effect) publishes hidden, which main treats as detach-but-keep-alive. So there
  is no separate "hidden" detach branch.
- **zoom rides the publish payload** (the `Placement` rect has no zoom field),
  kept in a ref so the imperative publisher always reads the live value; a zoom
  change forces one re-publish so main re-applies `setZoomFactor`.

See `project-window-layout.md` §3 for the anchor semantics.

## getSystemInfoSync in the service host

`wx.getSystemInfoSync()` must return a full object (incl. `safeArea`) in the
service host. Two things keep it working:

1. **Build order.** The service-host `sync-api-patch` imports the sync impls; one
   (`menu-button.ts`) imports the shared
   `simulator/device-shell/menu-button-geometry.js`, tsc-emitted into
   `dist/simulator/…` by `build:native-host`. `build:simulator` (vite,
   `emptyOutDir`) WIPES `dist/simulator`, so `build:native-host` MUST run AFTER
   `build:simulator` (the full `pnpm build` orders it this way — see the order
   note in `build-native-host.mjs`). A partial rebuild that runs `build:simulator`
   alone leaves a 404 → `sync-api-patch` fails to load → none of the sync APIs are
   patched → `getSystemInfoSync` falls through to dimina's async path → undefined.
2. **Nested host-env snapshot (belt-and-braces).** dimina's runtime reads
   `hostEnv.systemInfo`; `bridge-router.ts makeLoadResource` sends it nested as
   `hostEnv: { systemInfo, menuRect }` so dimina's own path also resolves it if
   the patch ever fails.

## Bottom safe area — one mechanism

The DeviceShell's `.device-shell__home-indicator` strip is sized to
`device.safeAreaInsets.bottom` (gesture-bar devices only; home-button SE-class
has bottom inset 0). The page's `env(safe-area-inset-bottom)` is injected as 0 —
the shell reserves the bottom, so there is a single bottom-inset mechanism. The
top safe area reaches the page via the CDP `setSafeAreaInsetsOverride`; the notch
is an in-screen occluder drawn by the DeviceShell's status bar. (See the
safe-area doc for the CDP wiring.)

## Key files

| file | role |
|---|---|
| `src/renderer/.../project-runtime/components/simulator-panel.tsx` | z2 panel: toolbar / placeholder / path-bar; owns the simulator `createPlacementAnchor` |
| `src/simulator/device-shell/device-shell.tsx` + `device-shell.css` | DeviceShell: draws the whole phone inside the WCV; hosts render-host `<webview>` guests |
| `src/main/services/views/native-simulator-view.ts` | native-simulator domain module: `attachNativeSimulator`, `softReloadNativeSimulator`, bounds/zoom application (`view-manager.ts` is the composition root wiring the per-domain view modules) |
| `src/main/services/layout/index.ts` | `computeNativeSimulatorViewParams` |
| `src/renderer/shared/api/view-api.ts` | `setNativeSimulatorBounds` IPC wrapper (`simulator:set-native-bounds`) |
| `src/service-host/sync-impls/menu-button.ts` | sync `getSystemInfoSync` path (build-order sensitive) |
