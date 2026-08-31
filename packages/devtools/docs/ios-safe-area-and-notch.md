# iOS Notch / Dynamic Island + CSS `env(safe-area-inset-*)` (native-host simulator)

The native-host simulator reproduces iOS devices with a notch / Dynamic Island,
so that:

1. The device bezel shows a visual **notch / Dynamic Island** + a status bar
   (time / signal / battery), matching the selected device profile.
2. A mini-program page laid out edge-to-edge resolves CSS
   `env(safe-area-inset-top|right|bottom|left)` to the device's real insets, so
   pinned headers / tabBars / action sheets avoid the notch and home indicator
   exactly as on-device.
3. CSS insets follow the selected device profile. The public JS APIs currently
   take different paths and do not all return the same `safeArea`; see below.

## Single source of truth: device profile

`DEVICES` in `src/renderer/shared/constants.ts` is the single source of truth.
Each entry carries the notch / safe-area fields:

```ts
notchType: 'none' | 'notch' | 'dynamic-island'
safeAreaInsets: { top: number; right: number; bottom: number; left: number }
```

`statusBarHeight` is kept = `safeAreaInsets.top` for `getSystemInfoSync`
back-compat; `safeAreaInsets.top` is the canonical value. Seeded data:

| device        | notchType        | top | bottom |
|---------------|------------------|-----|--------|
| iPhone SE     | none             | 20  | 0      |
| iPhone X      | notch            | 44  | 34     |
| iPhone 14     | notch            | 47  | 34     |
| iPhone 14 Pro | dynamic-island   | 54  | 34     |
| iPhone 16 Pro | dynamic-island   | 59  | 34     |
| iPhone 17 Pro | dynamic-island   | 59  | 34     |

`left` / `right` are `0` in portrait (landscape is out of scope).

## Device-info flow (native-host)

The selected device reaches the simulator UI/API state, the render-host CDP
override, and the service-host snapshot. All three update when the user switches
device:

```
toolbar device picker (renderer)
  → SimulatorChannel.SetDeviceInfo (src/main/ipc/simulator.ts)
    ├→ bridge caches device + DEVICE_CHANGE
    │   → simulator WCV / DeviceShell visual state
    │   → SimulatorMiniApp.currentDevice for async system-info handlers
    ├→ safe-area service re-applies CDP override to each render-host webview
    └→ HostEnvUpdate → service-host hostEnvSnapshot for sync handlers
```

- **Transport renderer → simulator.** The simulator is a top-level
  `WebContentsView` (not a `<webview>` of the main window), so device changes go
  via IPC, not `webview.send`. The toolbar picker drives
  `SimulatorChannel.SetDeviceInfo`; main caches it on the bridge and relays
  `DEVICE_CHANGE` to the live `simulatorWc`. `SimulatorMiniApp` records the
  event for simulator-resident API handlers, while DeviceShell subscribes and
  re-renders. Before the first live event, the initial device comes from the
  `NATIVE_HOST_ENABLED` boot config cached by the bridge.
- **DeviceShell device prop = single `device` object** (dims + platform +
  notchType + safeAreaInsets), initialized from `miniApp.getInitialDevice()` and
  updated from `SIMULATOR_EVENTS.DEVICE_CHANGE`. DeviceShell re-renders; the WCV
  bounds track the bezel rect via the layout pipeline.

## Visual: status bar + notch / Dynamic Island

The **status bar** is the first child of `.device-shell` (above the nav-bar),
`flex: 0 0 {safeAreaInsets.top}px`:

- Left: time (static `9:41`). Right: signal / wifi / battery glyphs
  (`.device-shell__status-icons`).
- The nav-bar is the 44pt title row beneath the status bar.

Notch shape (centered, overlapping the status bar), driven by `notchType`:

- `none`: nothing (SE-class). Status bar full width.
- `notch`: a black rounded pill anchored to the top, centered, ~`160×30`, bottom
  corners rounded. Status icons sit on either side.
- `dynamic-island`: a smaller black pill (~`125×37`), fully rounded, small top
  margin (~`11px`), centered. Status icons on either side.

It renders inside `.device-shell` (the positioning context), clipped by
`border-radius: 38px; overflow: hidden`. The notch shape is keyed by `notchType`
in `status-bar.tsx` so visual + safe-area stay consistent.

## CSS `env(safe-area-inset-*)` injection — CDP `Emulation.setSafeAreaInsetsOverride`

`env(safe-area-inset-*)` is UA-defined and cannot be overridden by an author
stylesheet, so the inset comes from CDP. `src/main/services/safe-area/index.ts`
sends `Emulation.setSafeAreaInsetsOverride` per render-host `<webview>` guest,
driven off the simulator WCV's **`did-attach-webview`** event — the earliest
point each guest `WebContents` is available, before the page paints.

- The `wc.debugger` session itself is not owned by safe-area: it goes through
  the shared `CdpSessionBroker` (`src/main/services/cdp-session/index.ts`). Its
  six service consumers are safe-area, elements-forward, render-inspect,
  network-forward, console-forward's CDP injection, and simulator-storage.
  (`service-console` attaches to service-host separately.) `wc.debugger` is a
  single-owner API, so without the broker any two
  of them attaching independently would steal/detach each other's session on
  the same guest. Per guest: `broker.acquire(wc)`
  returns a `CdpSessionLease`; safe-area calls
  `lease.send('Emulation.setSafeAreaInsetsOverride', { insets })` on it. `insets`
  carries **all 8 fields** (`top/topMax/right/rightMax/bottom/bottomMax/left/
  leftMax`, base == max) — omitting `*Max` leaves `env(safe-area-max-inset-*)`
  at 0. Safe-area tracks each guest's page type in its own `Map<WebContents, boolean>`
  (`isTabPage`, independent of the lease), and drops it on the guest's
  `destroyed` event; the lease itself is dropped on the broker's `onDetach`
  (an external tool stealing the session, or the wc dying) so the next
  `override` re-acquires instead of sending through a dead lease.
- **Re-apply triggers:** (1) guest attach (new page in the stack), (2) device
  change (reapply to all attached guests).
- **Inject only what the webview actually borders**, so the page's own `env()`
  padding never double-counts a region the shell already covers:
  - `top` = custom-nav page ? `device.safeAreaInsets.top` : `0` (the default nav
    bar covers the notch with its opaque bar).
  - `bottom` is per page TYPE:
    - tab page → `0`. The shell tabBar extends its background through the bottom
      inset; the page content sits above the tabBar and never borders the bottom
      unsafe zone.
    - non-tab page → `device.safeAreaInsets.bottom`. The page is full-bleed to
      the device bottom; the shell reserves nothing, so the page opts in via its
      own `env(safe-area-inset-bottom)`. The page type is read from the
      render-host URL's `isTab` flag, captured in `will-attach-webview`
      (`guestWc.getURL()` is empty at `did-attach`) and stored per guest so a
      device-change reapply reuses it.
  - `left` / `right` = `0` (portrait).
  This keeps CSS `env()` aligned with the unsafe region actually bordering the
  page webview. JS `safeArea` follows separate paths described below.
- **`webContents.debugger` is exclusive.** If an external tool
  (`--remote-debugging-port`) is attached to the render-host guest, `attach()`
  throws and we cannot take over its session — log a warning and leave insets at
  0. There is no CSS-only fallback.

## Bottom safe area — one mechanism

The home-indicator pill (`.device-shell__home-indicator`) is an absolute overlay
pinned to the device bottom — it reserves no layout space and is transparent.
What fills the bottom safe area depends on the page:

- *tab page* → the shell tabBar's `background` extends through the bottom inset
  (`padding-bottom` = `safeAreaInsets.bottom`, `tab-bar.tsx`), so the strip is
  the tabBar's color and the pill sits on it.
- *non-tab page* → the page webview is full-bleed to the device bottom (no
  reserved strip); the pill overlays the page content.

Because the DeviceShell already reserves the bottom, the page's
`env(safe-area-inset-bottom)` is overridden to 0 on tab pages — the page's own
`env(bottom)` must not double-count.

## JS `safeArea`: the public APIs currently diverge

`safeArea.bottom` is a coordinate, not an inset. On a device with a home
indicator it should equal `windowHeight - safeAreaInsets.bottom`. The current
public paths are:

| Public API | Resolution path | Current result |
| --- | --- | --- |
| `wx.getSystemInfoSync()` | `sync-api-patch.ts` → service-host `sync-impls/system-info.ts` | includes `safeArea`, but sets `bottom = windowHeight` |
| `wx.getWindowInfo()` | upstream service `hostEnvResolvers.getWindowInfo` reads the service-host `HostEnvSnapshot` locally | does not include `safeArea`, because the snapshot has no such field |
| `wx.getSystemInfo()` / `wx.getSystemInfoAsync()` | bridge `invokeAPI` → simulator `buildSystemInfo()` | includes the device bottom inset and sets `bottom = windowHeight - bottomInset` |

The simulator also exposes a local `getWindowInfo` handler whose
`safeArea.bottom` is `windowBounds.height`, but a normal business call does not
reach it: upstream service intercepts `getWindowInfo` in `hostEnvResolvers`
before bridge dispatch. In contrast, the async system-info APIs are not local
host-env resolvers and do reach `buildSystemInfo()`.

The initial snapshot and later `HostEnvUpdate` payload are built by `deviceInfoToHostEnv` in
`packages/dimina-electron-runtime/src/shared/bridge-channels.ts`; it carries
`statusBarHeight` but neither `safeAreaInsets` nor `safeArea`. The similarly
named devtools file only re-exports that runtime module. CSS
`env(safe-area-inset-bottom)` is independent of these JS paths and comes from
the CDP override.

## Key files

| file | role |
|---|---|
| `src/renderer/shared/constants.ts` | `DEVICES` profile (notchType + safeAreaInsets) |
| `src/main/ipc/simulator.ts` | `SimulatorChannel.SetDeviceInfo` → bridge cache → `DEVICE_CHANGE`; sends `deviceInfoToHostEnv` |
| `packages/dimina-electron-runtime/src/shared/bridge-channels.ts` | `deviceInfoToHostEnv` (device profile → service-host host-env) |
| `src/main/services/safe-area/index.ts` | per-guest `Emulation.setSafeAreaInsetsOverride` (driven off `did-attach-webview`) |
| `src/simulator/device-shell/status-bar.tsx` | status bar + notch / Dynamic Island visual |
| `src/service-host/sync-impls/system-info.ts` | `getSystemInfoSync().safeArea` |
