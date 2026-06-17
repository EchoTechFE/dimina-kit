# iOS Notch / Dynamic Island + CSS `env(safe-area-inset-*)` (native-host simulator)

The native-host simulator reproduces iOS devices with a notch / Dynamic Island,
so that:

1. The device bezel shows a visual **notch / Dynamic Island** + a status bar
   (time / signal / battery), matching the selected device profile.
2. A mini-program page laid out edge-to-edge resolves CSS
   `env(safe-area-inset-top|right|bottom|left)` to the device's real insets, so
   pinned headers / tabBars / action sheets avoid the notch and home indicator
   exactly as on-device.
3. `wx.getSystemInfoSync().safeArea` / `getWindowInfo()` report the same insets
   (JS and CSS agree).

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

The device profile reaches three consumers, all live-updatable when the user
switches device:

```
toolbar device picker (renderer)
  → SimulatorChannel.SetDeviceInfo (src/main/ipc/simulator.ts)
  → main caches on the bridge (ctx.bridge.setDevice) + relays DEVICE_CHANGE
  → simulator WCV / DeviceShell (resize + render notch/status bar + window.__deviceInfo)
  → CDP inset override on each render-host webview
```

- **Transport renderer → simulator.** The simulator is a top-level
  `WebContentsView` (not a `<webview>` of the main window), so device changes go
  via IPC, not `webview.send`. The toolbar picker drives
  `SimulatorChannel.SetDeviceInfo`; main caches it on the bridge and relays
  `DEVICE_CHANGE` to the live `simulatorWc`; a listener in `simulator/main.tsx`
  lifts it into React state + `window.__deviceInfo`. The initial device is the
  first `device:change` — one code path.
- **DeviceShell device prop = single `device` object** (dims + platform +
  notchType + safeAreaInsets), held in `SimulatorApp` state and updated on
  `device:change`. DeviceShell re-renders; the WCV bounds track the bezel rect
  via the layout pipeline.

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
attaches `wc.debugger` per render-host `<webview>` guest and sends
`Emulation.setSafeAreaInsetsOverride`, driven off the simulator WCV's
**`did-attach-webview`** event — the earliest point each guest `WebContents` is
available, before the page paints.

- Per guest: `guestWc.debugger.attach('1.3')` →
  `sendCommand('Emulation.setSafeAreaInsetsOverride', { insets })`. `insets`
  carries **all 8 fields** (`top/topMax/right/rightMax/bottom/bottomMax/left/
  leftMax`, base == max) — omitting `*Max` leaves `env(safe-area-max-inset-*)`
  at 0. Track `Map<WebContents, 'attached'|'detached'>`; clear on guest
  `destroyed`.
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
  This keeps JS `safeArea` (full device insets) and CSS `env()` (what the page
  webview borders) each correct for their consumer.
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

## JS `safeArea` parity

`simulator-api.ts` computes `safeArea` from `window.__deviceInfo`. The full
`safeAreaInsets` object is carried end-to-end (`device:change` payload →
`window.__deviceInfo` AND the service-host host-env) and
`getWindowInfo` / `getSystemInfoSync` prefer it. Three places must agree:

- `simulator-api.ts` (`safeArea` from `window.__deviceInfo`).
- `service-host/sync-impls/system-info.ts` (`getSystemInfoSync`).
- `deviceInfoToHostEnv` (`src/shared/bridge-channels.ts`), sent from
  `main/ipc/simulator.ts` to the service host.

JS `safeArea` reports the FULL device insets (canonical device truth); CSS
`env()` reports only what the webview borders (above) — different consumers, both
correct.

## Key files

| file | role |
|---|---|
| `src/renderer/shared/constants.ts` | `DEVICES` profile (notchType + safeAreaInsets) |
| `src/main/ipc/simulator.ts` | `SimulatorChannel.SetDeviceInfo` → bridge cache → `DEVICE_CHANGE`; sends `deviceInfoToHostEnv` |
| `src/shared/bridge-channels.ts` | `deviceInfoToHostEnv` (device profile → service-host host-env) |
| `src/main/services/safe-area/index.ts` | per-guest `Emulation.setSafeAreaInsetsOverride` (driven off `did-attach-webview`) |
| `src/simulator/device-shell/status-bar.tsx` | status bar + notch / Dynamic Island visual |
| `src/service-host/sync-impls/system-info.ts` | `getSystemInfoSync().safeArea` |
