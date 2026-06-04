# Native-host simulator rendering architecture (bezel / WCV bounds / zoom)

Status: FINALIZED (codex review, 2026-06-03). Decision: **Model A**. Goal: ONE
coherent model so the "phone clips / gray surround / white strip / black
overflow" class of bugs cannot recur.

## Codex-finalized decisions

- **Model A — GO.** Renderer's existing bezel (`simulator-panel.tsx:125-145`,
  outer shell+shadow + inner black screen) becomes the visible frame; WCV =
  inner-screen; DeviceShell fills with ONLY screen chrome. Removes the real
  desk/bezel duplication.
- **Bounds surgery — collapse to ONE authority** (`view-manager.ts`):
  - KEEP `setNativeSimulatorViewBounds` (sole authority + radius + zoom
    propagation) and ALL renderer-side reportBounds triggers (ResizeObserver /
    scroll / window-resize / zero-bounds cleanup).
  - REMOVE the coarse `applyNativeSimulatorBounds(simWidth)` from
    `attachNativeSimulator` (incl. its `addChildView`/`nativeSimulatorViewAdded`),
    from `resize()`, and from `repositionAll()`. Retire `computeNativeSimulatorBounds`
    from the native path.
  - MODIFY: `setNativeSimulatorViewBounds` must CACHE the renderer rect even when
    the view doesn't exist yet (today it early-returns and DISCARDS it — the
    project-open ordering means the renderer's first report can land before
    `attachNativeSimulator`). On attach, if a non-zero rect is cached, add+size
    the WCV immediately; else leave it unattached until the next report adds+sizes
    it. The WCV is added to the contentView from the bounds path, not from attach.
  - This is why "remove from resize() ALONE" gave black overflow last time:
    attach/repositionAll still ran coarse AND the pre-attach report was discarded,
    so the WCV kept a stale/coarse size while the DeviceShell (still drawing the
    larger desk+bezel) overflowed the inner-screen WCV. The DeviceShell strip and
    the bounds collapse MUST land together.
- **Notch stays in the DeviceShell** (an in-screen occluder, z-index 300); moving
  it to the renderer bezel would put it UNDER the WCV. safe-area top reaches the
  page via the CDP override (already wired); bottom = home-indicator strip.
- **getSystemInfoSync undefined** — TWO causes, both fixed:
  1. PRIMARY (build): the service-host `sync-api-patch` imports the sync impls,
     one of which (`menu-button.ts`) imports the shared
     `simulator/device-shell/menu-button-geometry.js`. That file is tsc-emitted
     into `dist/simulator/…` by `build:native-host`, but `build:simulator`
     (vite, `emptyOutDir`) WIPES `dist/simulator`. So a partial rebuild
     (build:simulator without re-running build:native-host) leaves a 404 →
     `sync-api-patch` fails to load → NONE of the sync APIs are patched →
     `wx.getSystemInfoSync()` falls through to dimina's async path → undefined.
     Fix: `build:native-host` must run AFTER `build:simulator` (the full
     `pnpm build` already orders it this way — see the order note in
     build-native-host.mjs). Confirmed fixed: getSystemInfoSync returns a full
     object incl. `safeArea` (proving the patch loaded).
  2. SECONDARY (belt-and-braces): dimina's runtime reads `hostEnv.systemInfo`,
     but `bridge-router.ts makeLoadResource` sent a FLAT `HostEnvSnapshot`. Now
     nested as `hostEnv: { systemInfo: ap.hostEnv, menuRect: null }` so dimina's
     OWN path also resolves it if the patch ever fails (render does NOT read
     hostEnv; the devtools patch reads the separate spawnContext, both fine).

## Current architecture (mapped — the defects)

The native simulator is a top-level `WebContentsView` (WCV) overlaid on a region
of the main-window React renderer. The WCV loads `simulator.html` → `DeviceShell`
(phone chrome) + per-page render-host `<webview>` (the page).

### Defect 1 — DOUBLE bezel (the renderer's is dead)

- The RENDERER (`simulator-panel.tsx:125-166`) draws a full phone: an outer
  silver bezel (boxShadow shell+border, radius 44, size `device.w*scale ×
  device.h*scale`) and an inner BLACK screen div (radius 36, `device.w ×
  device.h`, `transform: scale(scale)`).
- The WCV is overlaid on the inner black div's measured rect. So **both renderer
  bezels are painted over (occluded) by the WCV — they never show.**
- The VISIBLE phone is 100% the DeviceShell's: `.device-shell-root` (gray
  `#e7ebef` "desk", `padding:24`, flex-center) + `.device-shell` (border,
  radius 38, shadow, `#f8fafc`). So there are TWO bezels drawn; one is dead.

### Defect 2 — WCV bounds RACE (4 paths, 2 sizes)

Four code paths set the WCV bounds, producing TWO different sizes:

| path | when | size |
|---|---|---|
| `attachNativeSimulator` → `applyNativeSimulatorBounds` | initial | COARSE = panel width (`computeNativeSimulatorBounds`) |
| `resize()` → `applyNativeSimulatorBounds` | splitter drag / device change | COARSE = panel width |
| `repositionAll()` → `applyNativeSimulatorBounds` | window resize | COARSE = panel width |
| `setNativeSimulatorViewBounds` (renderer reportBounds) | rAF after any geometry change | PRECISE = device inner-screen rect |

The coarse paths are synchronous (main); the precise path is async (renderer rAF
+ IPC). They fire together on resize/device-change and **whichever lands last
wins**. So the WCV flips between:
- PRECISE (inner-screen, device width): correct size, BUT the DeviceShell's desk
  (`device.w + 48` padding) overflows it → the phone CLIPS.
- COARSE (panel width, wider): the DeviceShell's phone centers in it with the
  gray desk showing → gray side-surround + (because `.device-shell-root` was
  `min-height:100%` not filling the taller WCV) a white bottom strip.

This race is THE root cause of the recurring clip↔surround↔overflow churn.

### Defect 3 — zoom invariant only holds on the precise path

Intended: `WCV_logical_width = bounds.width / zoomFactor = device.width` at any
zoom (renderer measures `device.w*scale`, main sets bounds=that + zoomFactor=scale).
Holds on the precise path; the COARSE path sets bounds=panel width with the same
zoomFactor → logical width = panel/scale ≠ device.width → page renders at the
wrong logical width whenever coarse wins.

### Defect 4 — chrome double-reserve at the bottom (minor)

`.device-shell__home-indicator` reserves `bottomInset` AND `tab-bar.css` has
`padding-bottom: env(safe-area-inset-bottom)` (0 in the WCV unless injected) —
two mechanisms for the bottom safe area. Pick one.

### Defect 5 — service-host `getSystemInfoSync()` returns undefined

The demo's `loadDeviceInfo` does `wx.getSystemInfoSync().screenWidth` and throws
`Cannot read properties of undefined`. So `wx.getSystemInfoSync()` resolves to
undefined in the service host. Separate from layout; tracked here, fixed alongside.

## Decision: ONE bezel owner + ONE bounds size

Two coherent models. Both fix the race by making the WCV a single, stable size.

### Model A — renderer owns the frame; WCV = inner-screen; DeviceShell fills (RECOMMENDED)

- The RENDERER's bezel + desk become the VISIBLE frame (un-hide them: the WCV is
  sized to EXACTLY the inner black screen, so the silver bezel around it shows).
- The WCV = the device inner-screen (device.w × device.h, scaled). Single size.
- The DeviceShell FILLS the WCV (100% × 100%) with ONLY the screen content
  (status bar, nav-bar, page webview, tab-bar, home-indicator). It draws NO
  bezel, NO desk, NO padding. The WCV's `setBorderRadius` rounds the corners.
- Bounds: the renderer's `reportBounds` (inner-screen) is the **SOLE authority**.
  KILL the coarse panel paths (attach/resize/repositionAll) — or make them no-ops
  for the native simulator. Handle the initial frame by not painting the WCV
  until the first `reportBounds` lands (hide → show), so there is never a coarse
  size to flip from.
- Pros: reuses the renderer's existing styled bezel; WCV is a pure screen
  (simplest model); one bounds authority ⇒ no race; zoom invariant always holds.
- Cons: the renderer's bezel must be un-hidden + polished; a 1-frame defer on the
  initial paint.

### Model B — DeviceShell owns the frame; WCV = panel

- Remove the renderer's bezel (keep only a sizing container). The WCV = the panel
  region. The DeviceShell draws desk + bezel + content, centering a device-width
  phone in the panel-sized WCV.
- Bounds: make ALL paths produce the PANEL size (the renderer stops sending the
  inner-screen rect; or reportBounds measures the panel). Single size.
- Pros: DeviceShell self-contained. Cons: discards the renderer's bezel; the
  DeviceShell must own desk/centering/scroll; page width must be pinned to
  device.width while the WCV is panel-width (centering), re-introducing a
  width-vs-logical subtlety.

**Recommendation: Model A.** It removes dead code (the hidden renderer bezel
becomes the real one), makes the WCV a pure device screen, and collapses 4 bounds
paths into 1 — directly killing the race. The DeviceShell simplifies to just the
on-screen chrome.

## reportBounds observer gap (answers Open Question 3)

Collapsing to the single renderer authority exposed a real gap: a **left/right
column-splitter drag** (and right-pane open/close, header/toolbar height change)
MOVES the centered bezel by resizing the COLUMN — but it does NOT resize the
fixed device-size inner-screen div. The old `reportBounds` effect only
`ResizeObserver`-ed the inner div + listened for scroll + window-resize.
`ResizeObserver` reports SIZE, not POSITION, so a column resize that re-centers
the bezel fired NOTHING → the WCV lagged the bezel (visible bezel/screen
misalignment). The old coarse `repositionAll()`/`resize()` had masked this.

Fix (`simulator-panel.tsx`): also `ResizeObserver`-observe the **scroll
container** (the panel column the bezel is centered in). It resizes on every
column-geometry change (splitter drag, right-pane toggle, header height, window
resize), so `reportBounds` re-measures the bezel's new position. This is
position-aware via the resizing ancestor — no per-event whack-a-mole.

### UPDATE (ViewAnchor migration) — the bespoke `reportBounds` is gone

The native-host refactor turned the simulator from a renderer `<webview>` into a
main-process `WebContentsView` — a native overlay, exactly like the Chromium
DevTools view, which the renderer already binds to its DOM via the shared,
tested `useViewAnchor` (`packages/view-anchor/`). The refactor MISSED
migrating the simulator onto that abstraction; instead the simulator grew the
bespoke `reportBounds` effect above, which re-derived — badly, with the very
observer gap this section patched — what `useViewAnchor` already does correctly
(the DevTools anchor handles the same class of "the rect moved without
resizing" via its `deps`).

The simulator now uses `useViewAnchor` too. Two small, general, separately-tested
additions let one abstraction serve both overlays:
- **`measure` redirect** — the anchor OBSERVES the scroll container (which
  resizes on splitter drag / window resize and fires `scroll` when a tall bezel
  overflows) but PUBLISHES the inner-screen rect. So "what signals the move" and
  "what the WCV must match" are decoupled cleanly, instead of observing two
  elements by hand.
- **`scroll`-on-target** — the anchor listens for `scroll` on its target; for a
  scroll-container target (the simulator's) this catches a tall bezel scrolling;
  for a non-scrolling target (DevTools' placeholder) it is a no-op.

Result: the WCV bounds are STILL the renderer's sole authority (everything in
"Model A — concrete plan" below holds), but the binding is now the same
`useViewAnchor` for all DOM-anchored overlays — the splitter/scroll re-measure
gap is closed at the abstraction layer, not re-patched per overlay. The
unmount-time ZERO that collapses the WCV is the hook's tested teardown (no
bespoke cleanup). `simulator-panel.tsx` line/section references above point at
the pre-migration code. (Settings / compile-popover are full-region overlays
positioned by main with no DOM placeholder, so they are not ViewAnchor-bound.)

## Model A — concrete plan

1. **Bounds = single authority.** Native simulator WCV bounds come ONLY from
   `setNativeSimulatorViewBounds` (renderer `reportBounds`). Remove
   `applyNativeSimulatorBounds` calls from `resize()` and `repositionAll()` for
   the native view; on `attachNativeSimulator`, add the view but defer its first
   `setBounds` until the first renderer rect arrives (keep it hidden until then
   to avoid a flash). `computeNativeSimulatorBounds` (the coarse panel fn) is
   retired for the native path.
2. **DeviceShell fills the WCV.** `.device-shell-root` + `.device-shell` →
   `width:100%; height:100vh` (or flex-fill), NO padding, NO desk bg, NO border /
   radius / shadow. Keep `.device-shell position:relative` (overlay containment).
   Drop the inline `width/height` device sizing and the `@media(max-width:460px)`
   hack. `device` is still read for status-bar height / notch / bottom inset.
3. **Renderer bezel becomes visible.** Confirm the WCV is sized to the inner
   black rect (it already is). Keep the outer silver bezel + shadow (now visible).
   The inner black div can stay as the screen backdrop behind the WCV (shows for
   the 1 frame before the WCV paints, and as the rounded-corner mask).
4. **Bottom safe area = one mechanism.** Keep the home-indicator strip sized to
   `device.safeAreaInsets.bottom`; the page's `env(safe-area-inset-bottom)` is
   injected as 0 (the shell reserves the bottom). Documented in the safe-area doc.
5. **getSystemInfoSync fix.** Diagnose why the service-host `wx.getSystemInfoSync`
   returns undefined and restore it (so `loadDeviceInfo` stops throwing).

## Open questions for codex

1. Model A vs B — agree with A? Any reason the renderer's bezel should NOT be the
   visible frame (e.g. it can't render a notch cutout, or scroll behavior)?
2. Initial-frame handling in Model A: defer-until-first-reportBounds (hide→show)
   vs seed an inner-screen estimate in main. Which is more robust against a
   missing/late reportBounds?
3. Is removing `applyNativeSimulatorBounds` from `repositionAll()`/`resize()`
   safe, or is there a window-resize case where the renderer's `reportBounds`
   does NOT fire (so the WCV would keep stale bounds)?
4. Should the renderer's bezel own the NOTCH cutout too (drawing it in the bezel
   frame, outside the WCV), or keep the notch inside the DeviceShell (current)?
5. The `getSystemInfoSync` undefined — likely cause + fix location.
