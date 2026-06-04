# iOS Notch / Dynamic Island + CSS `env(safe-area-inset-*)` (native-host simulator)

Status: REVIEWED (codex, 2026-06-02). CDP mechanism empirically VERIFIED. Owner: simulator/device-shell.

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

## Current state (what's broken / missing)

- **Device selection never reaches the native-host `DeviceShell`.**
  `simulator/main.tsx` renders `<DeviceShell miniApp bridgeId platform />` and
  nothing else — `width`/`height` fall back to the component defaults
  (`390 × 844`). Picking "iPhone SE" / "iPhone 16 Pro" in the toolbar does not
  resize or re-profile the simulator.
- **`device:change` is a dead IPC.** `use-device.ts` posts a `device:change`
  message, but nothing in the native-host runtime listens for it or writes
  `window.__deviceInfo`, so `simulator-api.ts` always falls back to its
  defaults (status bar 44, no per-device safe area). (Pre-existing; deferred
  while the simulator was being rewritten — this rework is that rewrite.)
- **No status bar / notch visual.** `device-shell` renders nav-bar → viewport →
  tabBar → home-indicator. The status-bar region only exists as `paddingTop`
  inside the nav-bar; there is no time/signal/battery row and no notch shape.
- **`env(safe-area-inset-*)` is `0` inside render-host webviews.** Desktop
  Chromium has no physical notch, so dimina's compiled WXSS that uses
  `env(safe-area-inset-bottom)` (tabBar padding, action sheets, weui-tabbar)
  gets `0`.

## Single source of truth: device profile

Extend `DEVICES` in `src/renderer/shared/constants.ts`. Today each entry is
`{ name, width, height, pixelRatio, statusBarHeight, system, safeAreaBottom }`.
Add:

```ts
notchType: 'none' | 'notch' | 'dynamic-island'
safeAreaInsets: { top: number; right: number; bottom: number; left: number }
```

`statusBarHeight` stays = `safeAreaInsets.top` (keep both for back-compat with
`getSystemInfoSync`; `safeAreaInsets.top` is the canonical value). Seed data:

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

Design choices to settle with codex:

- **Transport renderer→simulator.** The simulator is a top-level
  `WebContentsView` (not a `<webview>` of the main window), so
  `webview.send('device:change')` from the old path does not apply. Options:
  (A) main `ipcMain` relay → `simulatorWc.send('device:change', info)` +
  a listener in `simulator/main.tsx` that lifts it into React state and
  `window.__deviceInfo`; (B) carry the initial device in the simulator URL
  query and only relay *changes* over IPC. Lean (A) for one code path; the
  initial device is just the first `device:change`.
- **DeviceShell device prop.** Replace the defaulted `width`/`height` with a
  single `device` object (dims + platform + notchType + safeAreaInsets), held in
  `SimulatorApp` state and updated on `device:change`. DeviceShell re-renders;
  the WCV bounds already track the bezel rect via the existing layout pipeline.

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
- **Insets value — avoid double-counting (codex Q4).** The shell already
  RESERVES the chrome edges (in-flow nav-bar at top, tabBar + home-indicator at
  bottom), so the guest webview does not span those unsafe zones for a default
  page — injecting the full device inset there would double-count against the
  page's own `env()` padding. So inject only the inset for edges the webview
  actually borders the unsafe zone:
  - `top` = custom-nav page ? `device.safeAreaInsets.top` : `0`
    (default nav covers the notch with the opaque bar).
  - `bottom` = `0` — the shell's home-indicator strip (sized to
    `device.safeAreaInsets.bottom`, see below) reserves the bottom; the webview
    ends above it.
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
- DOM probe a render-host page that uses `env(safe-area-inset-bottom)` (e.g. a
  bottom-pinned bar): computed `padding-bottom` reflects the device bottom inset
  after the CDP override (0 before).
- `getSystemInfoSync().safeArea` over the bridge equals the device profile.
- e2e: switching device updates bezel dims + status bar height (assert via the
  simulator WCV DOM). Screenshot the WCV (chrome composits reliably in CDP;
  page content does not — verify content via DOM).

## Open questions for codex

1. Transport (A vs B) for renderer→simulator device info; any race between the
   first `device:change` and `DeviceShell` mount.
2. Where the CDP `setSafeAreaInsetsOverride` wiring should live (a new
   `services/safe-area` module vs folding into the existing render-host attach
   path in `bridge-router`/`view-manager`), and how it composes with the
   render-host webview lifecycle (per-page attach/detach).
3. Whether to keep `statusBarHeight` as a separate field or derive everywhere
   from `safeAreaInsets.top` (back-compat with existing tests).
