# iOS Notch / Dynamic Island + CSS `env(safe-area-inset-*)` (native-host simulator)

Status: SHIPPED (codex-reviewed 2026-06-02). CDP mechanism empirically VERIFIED. Owner: simulator/device-shell.

> This is the design doc; the design landed. See "Current state — SHIPPED" for
> the live reference points. The sections below describe the model/decisions and
> read as a plan, but they match the shipped code (device profile in `DEVICES`,
> `device:change` transport, status-bar/notch visual, the `services/safe-area`
> CDP wiring, and JS `safeArea` parity).

## CDP mechanism — VERIFIED (live, Electron 41 / Chromium 146)

Ran against the running app's render-host `<webview>` guest:

```
probe: padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom)
BEFORE: top=0px  bottom=0px
→ Emulation.setSafeAreaInsetsOverride { insets: { top:47, right:0, bottom:34, left:0 } }  → {}
AFTER:  top=47px bottom=34px      ✓
```

So the command exists, works on a `<webview>` GUEST (not just top-level), and
drives `env(safe-area-inset-*)` directly. **GO.** Two codex corrections folded
in below:

- The full `SafeAreaInsets` type has **8 fields**: `top/topMax/right/rightMax/
  bottom/bottomMax/left/leftMax`. The 4 base fields suffice for
  `env(safe-area-inset-*)` (verified) but omitting `*Max` leaves
  `env(safe-area-max-inset-*)` at 0 — send all 8 (mirror base = max).
- `webContents.debugger` is a **separate, exclusive** CDP client. If an external
  tool (`--remote-debugging-port=9222`) is attached to the render-host guest,
  `attach()` throws and we cannot take over its session. Degrade gracefully:
  log a warning, leave insets at 0 (do NOT claim we can "reuse" the session).

## Goal

Make the native-host simulator faithfully reproduce iOS devices that have a
notch or Dynamic Island, so that:

1. The device bezel shows a visual **notch / Dynamic Island** + a status bar
   (time / signal / battery), matching the selected device profile.
2. A mini-program page laid out edge-to-edge resolves CSS
   `env(safe-area-inset-top|right|bottom|left)` to the device's real insets, so
   pinned headers / tabBars / action sheets avoid the notch and home indicator
   exactly as on-device.
3. `wx.getSystemInfoSync().safeArea` / `getWindowInfo()` report the same insets
   (JS and CSS agree).

## Current state — SHIPPED

The design below SHIPPED. The reference points are live in code, not aspirational:

- **Device selection reaches the native-host `DeviceShell`.** The toolbar device
  picker drives `SimulatorChannel.SetDeviceInfo` (`src/main/ipc/simulator.ts`),
  which caches the selection on the bridge (`ctx.bridge.setDevice`) and pushes a
  `DEVICE_CHANGE` to the live simulator WCV. `DeviceShell` holds the selected
  `device` and re-renders the bezel size + status bar + notch on change.
- **`device:change` is live.** The device payload carries `notchType` +
  `safeAreaInsets`; switching device resizes/re-profiles the simulator and
  updates `window.__deviceInfo` (`simulator-api.ts` reads per-device values
  instead of the old fallbacks).
- **Status bar + notch visual ship.** `device-shell` renders a `StatusBar`
  (`status-bar.tsx`) pinned to the device top — time (`9:41`) + signal/wifi/
  battery — and the notch / Dynamic Island shape driven by `notchType`; nav-bar
  is the title row beneath it.
- **Bottom safe area is page-type-aware (WeChat parity).** The home-indicator
  pill is an ABSOLUTE overlay pinned to the device bottom — it reserves no layout
  space and is transparent. What fills the bottom safe area depends on the page:
  - *tab page* → the shell tabBar's `background` extends through the bottom inset
    (`padding-bottom` = `safeAreaInsets.bottom`, `tab-bar.tsx`), so the strip is
    the tabBar's color and the pill sits on it.
  - *non-tab page* → the page webview is full-bleed to the device bottom (no
    reserved strip); the pill overlays the page content.
- **`env(safe-area-inset-*)` is overridden inside render-host webviews.**
  `src/main/services/safe-area/index.ts` attaches `wc.debugger` per render-host
  `<webview>` guest on `did-attach-webview` (`view-manager.ts`) and sends
  `Emulation.setSafeAreaInsetsOverride`, so a page's `env(safe-area-inset-*)`
  resolves to the device insets instead of `0`. The TOP inset is always surfaced
  (notch). The BOTTOM inset is per page TYPE: a **tab page → 0** (the shell tabBar
  covers the safe area), a **non-tab page → the real inset** so the page opts in
  via its own `env(safe-area-inset-bottom)` — it is NOT auto-reserved. The page
  type is read from the render-host URL's `isTab` flag (captured in
  `will-attach-webview`). Re-applied on every device change (each guest keeps its
  attached page type); degrades gracefully (warn, leave 0) if the guest is
  already claimed by an external CDP client.

## Single source of truth: device profile

`DEVICES` in `src/renderer/shared/constants.ts` is the single source of truth, and
each entry now carries the notch/safe-area fields (SHIPPED):

```ts
notchType: 'none' | 'notch' | 'dynamic-island'
safeAreaInsets: { top: number; right: number; bottom: number; left: number }
```

`statusBarHeight` stays = `safeAreaInsets.top` (both kept for back-compat with
`getSystemInfoSync`; `safeAreaInsets.top` is the canonical value). Seeded data
(live in `constants.ts:10-15`):

| device        | notchType        | top | bottom |
|---------------|------------------|-----|--------|
| iPhone SE     | none             | 20  | 0      |
| iPhone X      | notch            | 44  | 34     |
| iPhone 14     | notch            | 47  | 34     |
| iPhone 14 Pro | dynamic-island   | 54  | 34     |
| iPhone 16 Pro | dynamic-island   | 59  | 34     |
| iPhone 17 Pro | dynamic-island   | 59  | 34     |

`left`/`right` are `0` in portrait (landscape is out of scope for v1).

## Device-info flow (native-host)

The device profile must reach three consumers, all live-updatable when the user
switches device:

```
toolbar device picker (renderer)
  → use-device.sendDeviceInfo  (already exists; extend payload with
      notchType + safeAreaInsets)
  → main process               (forward to the simulator WCV + apply CDP inset
      override on each render-host webview)
  → simulator WCV / DeviceShell (resize + render notch/status bar + window.__deviceInfo)
```

Design decisions (SHIPPED):

- **Transport renderer→simulator = option (A).** The simulator is a top-level
  `WebContentsView` (not a `<webview>` of the main window), so the old
  `webview.send('device:change')` does not apply. Shipped path: the toolbar
  picker drives `SimulatorChannel.SetDeviceInfo` → main caches on the bridge
  (`ctx.bridge.setDevice`) and relays a `DEVICE_CHANGE` to the live
  `simulatorWc.send(...)`; a listener in `simulator/main.tsx` lifts it into React
  state + `window.__deviceInfo`. One code path — the initial device is just the
  first `device:change` (option B was not taken).
- **DeviceShell device prop = single `device` object.** The defaulted
  `width`/`height` were replaced by one `device` object (dims + platform +
  notchType + safeAreaInsets), held in `SimulatorApp` state and updated on
  `device:change`. DeviceShell re-renders; the WCV bounds track the bezel rect via
  the existing layout pipeline.

## Visual: status bar + notch / Dynamic Island

Insert a **status-bar** element as the first child of `.device-shell` (above the
nav-bar), `flex: 0 0 {safeAreaInsets.top}px`:

- Left: time (static `9:41`, the iOS canonical). Right: signal / wifi / battery
  glyphs (reuse `.device-shell__status-icons`, already in CSS).
- The nav-bar's `paddingTop` (status-bar reservation) is removed; the nav-bar
  becomes just the 44pt title row beneath the status bar. (Keeps the in-flow
  layout we just fixed: status-bar + nav-row + viewport + tabBar + home.)

Notch shape (centered, overlapping the status bar), driven by `notchType`:

- `none`: nothing (SE-class). Status bar full width.
- `notch`: a black rounded "pill" anchored to the very top, centered, ~`160×30`,
  bottom corners rounded — the classic island cutout. Status icons sit on either
  side.
- `dynamic-island`: a smaller black pill (~`125×37`), fully rounded, with a
  small top margin (`~11px`), centered. Status icons on either side.

Render it inside `.device-shell` (which now establishes a positioning context),
clipped by the `border-radius: 38px; overflow: hidden`. Geometry lives in a
small `notch-geometry.ts` keyed by `notchType` so visual + safe-area stay
consistent.

## CSS `env(safe-area-inset-*)` injection — CDP `Emulation.setSafeAreaInsetsOverride`

Verified mechanism (above). Wiring (per codex):

- **New `services/safe-area` module**, NOT folded into bridge-router or
  simulator-storage. Driven from the **`did-attach-webview`** event on the
  simulator WCV (`view-manager.ts:649`) — the earliest point each render-host
  guest `WebContents` is available, and where zoom/nav hardening already lives.
  bridge-router's `renderWc` binding (`bridge-router.ts:1221`) is too late: the
  CSS must resolve before the page paints. simulator-storage attaches to the
  *simulator* webview with its own detach policy — keep separate.
- Per guest: `guestWc.debugger.attach('1.3')` →
  `sendCommand('Emulation.setSafeAreaInsetsOverride', { insets })` where `insets`
  carries **all 8 fields** (`top/topMax/right/rightMax/bottom/bottomMax/left/
  leftMax`, base==max). Track `Map<WebContents, 'attached'|'detached'>`; clear on
  guest `destroyed`.
- **Re-apply triggers:** (1) guest attach (new page in the stack), (2) device
  change (reapply to all attached guests).
- **Insets value — inject only what the webview actually borders.** Inject the
  inset for an edge only where the guest webview spans the unsafe zone, so the
  page's own `env()` padding never double-counts a region the shell already
  covers:
  - `top` = custom-nav page ? `device.safeAreaInsets.top` : `0`
    (default nav covers the notch with the opaque bar). (Surfaced as the top
    inset for all guests today; a full-bleed page needs it.)
  - `bottom` is per page TYPE (WeChat parity, see "Bottom safe area" above):
    - tab page → `0`. The shell tabBar extends its background through the bottom
      inset, and the page content sits above the tabBar — it never borders the
      bottom unsafe zone.
    - non-tab page → `device.safeAreaInsets.bottom`. The page is full-bleed to
      the device bottom; the shell reserves nothing, so the page opts in via its
      own `env(safe-area-inset-bottom)`. The page type is read from the
      render-host URL's `isTab` flag, captured in `will-attach-webview`
      (`guestWc.getURL()` is empty at `did-attach`) and stored per guest so a
      device-change reapply reuses it.
  - `left`/`right` = `0` (portrait v1).
  This keeps JS `safeArea` (full device insets) and CSS `env()` (what the page
  webview actually borders) each correct for their consumer.
- **Degradation:** if `attach()` throws (guest already claimed by an external
  `--remote-debugging-port` client) or the command errors, log a warning and
  leave insets at 0. There is no valid CSS-only fallback — `env()` is UA-defined
  and cannot be overridden by an author stylesheet (the earlier "inject a
  stylesheet defining env" idea is WRONG and dropped).

## JS `safeArea` parity

`simulator-api.ts` computes `safeArea` from `window.__deviceInfo`. But codex
found the JS path drops `safeAreaBottom` in TWO more places that must be fixed
for parity — the design is NOT just `simulator-api.ts`:

- `service-host/sync-impls/system-info.ts` (`getSystemInfoSync`) discards
  `safeAreaBottom`.
- `main/ipc/simulator.ts` `deviceInfoToHostEnv` discards it when forwarding to
  the service host.

Carry the full `safeAreaInsets` object end-to-end (`device:change` payload →
`window.__deviceInfo` AND the service-host host-env) and have
`getWindowInfo`/`getSystemInfoSync` prefer it. JS `safeArea` reports the FULL
device insets (canonical device truth); CSS `env()` reports only what the
webview borders (above) — different consumers, both correct.

Note the home-indicator strip (`.device-shell__home-indicator`, currently a
fixed 28px) should be sized to `device.safeAreaInsets.bottom` so the reserved
bottom matches the device (0 for SE, 34 for notch/DI devices).

## Test / verification

- DOM probe (CDP) the simulator WCV: status-bar height == `safeAreaInsets.top`,
  notch element present + centered for notch/dynamic-island, absent for `none`.
- DOM probe a render-host page that uses `env(safe-area-inset-top)` on a
  custom-nav page: computed `padding-top` reflects the device top inset after the
  CDP override (0 before). NOTE: `env(safe-area-inset-bottom)` stays **0** even
  after the override — the controller intentionally sends `bottom: 0` because the
  DeviceShell already reserves the home-indicator strip (`safe-area/index.ts`
  `guestInsets`), so the page's own `env(bottom)` must not double-count. Probe
  bottom only to assert it is 0.
- `getSystemInfoSync().safeArea` over the bridge equals the device profile.
- e2e: switching device updates bezel dims + status bar height (assert via the
  simulator WCV DOM). Screenshot the WCV (chrome composits reliably in CDP;
  page content does not — verify content via DOM).

## Decisions (resolved — codex-reviewed, SHIPPED)

1. **Transport = option (A)** — `SimulatorChannel.SetDeviceInfo` → bridge cache →
   `DEVICE_CHANGE` to `simulatorWc`; the first `device:change` seeds the initial
   device, so there is no separate initial-mount path to race against.
2. **CDP `setSafeAreaInsetsOverride` lives in a dedicated `services/safe-area`
   module** (`src/main/services/safe-area/index.ts`), driven off the simulator
   WCV's `did-attach-webview` so each per-page render-host guest gets insets
   before paint, and re-applied on device change — NOT folded into
   bridge-router/simulator-storage.
3. **`statusBarHeight` is kept as a separate field**, held = `safeAreaInsets.top`
   for back-compat with `getSystemInfoSync`; `safeAreaInsets.top` is the canonical
   value.
