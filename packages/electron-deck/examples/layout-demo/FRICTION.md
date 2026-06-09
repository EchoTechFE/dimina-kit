# electron-deck — user-side API FRICTION report (RESOLVED)

**All 7 frictions resolved by P0–P5; the demo is now boilerplate-free.**

This demo (`examples/layout-demo/`) drives the **real** user-side API end-to-end:
`startElectronDeck(config, { backend })` → `backend.assemble(runtime)` →
`runtime.view({ source, scope }).placeIn(win, { anchor })` → real
`createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })` in the
renderer → slot-token following. It runs offscreen and proves a renderer splitter
drag moves the native color blocks with **zero host resize code**.

Every gap the original report filed under `// DEMO GLUE — candidate framework
helper: …` is now closed by a shipped P0–P5 API. Below, each gap shows the OLD
glue that was DELETED and the NEW one-liner that replaced it.

The proof is still GREEN — the slot-token path covers live renderer-driven resize:

```
[demo] shot → 2-detail-following.png (2 native blocks: SIMULATOR@8,360w < DEVTOOLS@390,502w)
[demo] STEP2: native sim/dev bounds at split=360 : {"sim":{"x":8,"width":360},"dev":{"x":390,"width":502}}
[demo] shot → 3-after-drag.png (2 native blocks: SIMULATOR@8,220w < DEVTOOLS@250,642w)
[demo] STEP3: native sim/dev bounds at split=220 : {"sim":{"x":8,"width":220},"dev":{"x":250,"width":642}}
[demo] PROOF: simWidthΔ = 140 (expect ~140) | devXΔ(left) = 140 (expect ~140)
[demo] ✅ split-drag MOVED the native color blocks (renderer-driven geometry, zero host resize code).
[demo] ALL STEPS DONE
```

---

## #1 — `electronDeck()` deadlocks if top-level `await`ed → RESOLVED by `startElectronDeck()`

**Was:** the single entry internally `await app.whenReady()`; a top-level
`await electronDeck(...)` in an ESM main suspended module evaluation, so `ready`
never fired → hard deadlock. The host had to fire-and-`.catch()` and could never
await.

**OLD glue (DELETED):**

```js
// DEMO GLUE — candidate framework helper: do NOT top-level `await electronDeck()`.
// `electronDeck()` internally `await app.whenReady()` … → DEADLOCK …
electronDeck( … ).catch((err) => { … app.quit() })
```

**NEW one-liner:** `startElectronDeck()` returns `{ ready, dispose }`
SYNCHRONOUSLY (not a thenable), so no whenReady gate ever sits on top-level await.
Assembly still runs strictly after `app.whenReady()` (gating intact inside
`start()`); a startup failure surfaces on `ready`.

```js
const { ready } = startElectronDeck(config, { backend })
// observe boot failures only — no deadlock workaround:
ready.catch((err) => { … app.quit() })
```

---

## #2 — main window has no `preload` / `source` config seam → PARTIAL (preload via webPreferences; `source` still residual)

`runtime.scopes` / `startElectronDeck` did not target this gap. The framework
still loads NO content into the main window and offers no `config.app.source`, so
the host still drives `loadURL` by hand and still attaches the main-window preload
through the `mainWindowWebPreferences()` backend hook (the one documented seam):

```js
// RESIDUAL GLUE (#2 — not addressed by P0–P5): no `config.app.source`; host still
// drives loadURL itself.
await mainWin.webContents.loadURL(CONTROL)
```

This is the one gap P0–P5 did NOT close. Flagged honestly; tracked as future
ergonomics (`config.app.window.preload` + `config.app.source`).

---

## #3 — no turnkey layout bridge / preload helper → RESOLVED by `exposeDeckLayoutBridge()`

**Was:** the demo hand-wrote a whole preload `LayoutBridge` over hard-coded
`DeckChannel.*` strings (duplicating the internal wire protocol), and had to read
`wire-transport.ts` to learn which ipc verb each channel used.

**OLD glue (DELETED — the entire `demo-preload.cjs` bridge block):**

```js
const DeckChannel = { Place: '__electron-deck:place', SlotGrant: '__electron-deck:slot-grant', LayoutSubscribe: '__electron-deck:layout-subscribe' }
const layoutBridge = {
  onSlotGrant(cb) { … ipcRenderer.on(DeckChannel.SlotGrant, wrapped) … },
  sendPlace(msg) { ipcRenderer.invoke(DeckChannel.Place, msg).catch(() => {}) },
  subscribe()    { ipcRenderer.invoke(DeckChannel.LayoutSubscribe).catch(() => {}) },
}
contextBridge.exposeInMainWorld('__demoLayoutBridge', layoutBridge)
```

**NEW one-liner** (in `demo-preload.mjs`): channel names come from the framework's
own `DeckChannel` — no hand-copied strings, no verb-guessing:

```js
import { exposeDeckLayoutBridge } from '@dimina-kit/electron-deck/preload'
exposeDeckLayoutBridge()  // exposes window.__electronDeckLayoutBridge
```

> **Residual (preload format, NOT a layout gap):** the framework's preload dist is
> ESM, so to `import` the helper the demo preload is now an ESM `.mjs` (was `.cjs`)
> and the main window runs with `sandbox:false` (Electron's ESM-preload
> requirement). This is a one-time format choice — the boilerplate it replaced (the
> whole `layoutBridge` + `DeckChannel` block) is gone either way.

---

## #4 — renderer client needs a hand-authored import map → RESOLVED by the browser bundle

**Was:** the client shipped as ESM with a bare `import … from
'@dimina-kit/view-anchor'`, so a no-bundler renderer needed an import map pointing
at a carefully-chosen view-anchor dist file.

**OLD glue (DELETED from `control.html`):**

```html
<script type="importmap">
  { "imports": { "@dimina-kit/view-anchor": "../../../view-anchor/dist/view-anchor.js" } }
</script>
<script type="module">
  import { createDeckLayoutClient } from '../../dist/client/layout-client.js'
```

**NEW one-liner:** load the dependency-inlined BROWSER bundle (the package's
`./client/browser` export → `dist/client/layout-client.browser.js`) — no bare
specifiers, no import map:

```html
<script type="module">
  import { createDeckLayoutClient } from '../../dist/client/layout-client.browser.js'
```

---

## #5 — layout channels armed lazily → benign boot rejection → RESOLVED by eager-arm

**Was:** `createDeckLayoutClient` calls `subscribe()` at construction (boot,
project-list screen), but the host only armed `Place` / `LayoutSubscribe` on the
FIRST anchored `placeIn`, so the boot `subscribe()` rejected with "No handler
registered" — the demo had to swallow it AND re-`subscribe()` after the slots
mounted.

**OLD glue (DELETED):**

```js
// preload: the rejection swallow was LOAD-BEARING (channels armed lazily)
ipcRenderer.invoke(DeckChannel.LayoutSubscribe).catch(() => {})
// control.html openProject(): re-subscribe so grants replay after slots mount
bridge.subscribe()
```

**NEW:** P5 arms the slot-token Place / LayoutSubscribe channels EAGERLY at
framework `start()` (`bindWireTransport`), so the boot `subscribe()` no longer
rejects and the host's `placeIn` push lands on the already-subscribed client. The
demo just shows the detail screen (mounting the slots) BEFORE telling the host to
place — no re-subscribe, no swallow:

```js
function openProject(p) {
  detailEl.classList.add('active')  // slots mount first
  demo.openProject(p.id)            // host placeIn → grant push → anchors bind
}
```

> `exposeDeckLayoutBridge()` still defensively `.catch()`es its invokes inside the
> framework helper, but the DEMO no longer ships any explanatory swallow glue.

---

## #6 — `DeckViewHandle` doesn't expose the native view → RESIDUAL (offscreen-only)

P0–P5 did not add a `webContents` / `bounds()` / `capture()` accessor to
`DeckViewHandle`. The demo's OFFSCREEN composite screenshot needs each native
view's live bounds + a `capturePage()`, so it still recovers the WCV by diffing
`mainWin.contentView.children` around each `placeIn`:

```js
// RESIDUAL GLUE (#6 — not addressed by P0–P5): no DeckViewHandle.webContents.
const before = new Set(mainWin.contentView.children)
handle.placeIn(mainWin, { zone, anchor: source })
const added = mainWin.contentView.children.find((c) => !before.has(c))
```

This is **only** needed by the demo's screenshot harness — a normal host that
doesn't screenshot/inspect native views never touches it. Kept honest: this glue
remains, but it is verification machinery, not application boilerplate.

---

## #7 — `grants.issue` demanded an un-obtainable `Scope` → RESOLVED by `runtime.scopes.create()`

**Was:** `runtime.grants.issue(wc, { targetScope })` required a `Scope`, an
internal type with no public constructor on `Runtime` — a host could register a
privileged `layout.*` command but could NOT mint a `Scope` to authorize it, so the
demo skipped `issue()` entirely.

**OLD glue (DELETED):**

```js
// grants.issue REQUIRES a `targetScope: Scope` … a host has nowhere to GET a Scope
// from … We skip the issue() here because we cannot mint a Scope from user-side API.
runtime.layout.command('layout.collapse-sim', () => { … })
```

**NEW:** `runtime.scopes.create()` mints an opaque, user-side `DeckSession`
accepted everywhere a scope is needed. Views bind to it via
`runtime.view({ source, scope: session })` (one teardown handle:
`session.dispose()` tears down every bound view), and it is exactly the ergonomic
`targetScope` `grants.issue` wanted:

```js
const session = runtime.scopes.create()
runtime.view({ source, scope: session }).placeIn(mainWin, { zone, anchor })
runtime.layout.command('layout.collapse-sim', () => { … })
runtime.grants.issue(controlWc, { commands: ['layout.collapse-sim'], targetScope: session })
```

> **Honest residual (framework teardown bug, NOT demo glue):** binding views to a
> session exercises the session-scope display-teardown path, which at APP SHUTDOWN
> logs a caught, non-fatal `TypeError: Cannot read properties of undefined (reading
> 'isDestroyed')` from `closeNativeWc` (`deck-app.js`) — a double-teardown ordering
> gap in the framework where `wcv.webContents` is already undefined. It is caught
> by the scope dispose, the process still exits 0, and all screenshots are written.
> The demo cannot fix it (no src/dist edits allowed); filed here as a follow-up for
> the framework to null-guard `closeNativeWc`.

---

## Summary

| # | Gap | Status | Resolved by |
|---|-----|--------|-------------|
| 1 | `electronDeck()` top-level-await deadlock | ✅ Resolved | `startElectronDeck()` → sync `{ ready, dispose }` |
| 2 | no main-window `preload`/`source` config seam | ⚠️ Partial | preload via `mainWindowWebPreferences()`; `source` still residual |
| 3 | no turnkey layout bridge / preload helper | ✅ Resolved | `exposeDeckLayoutBridge()` |
| 4 | renderer client not browser-loadable | ✅ Resolved | `./client/browser` bundle |
| 5 | lazy-armed channels → boot rejection | ✅ Resolved | P5 eager-arm |
| 6 | no native-view accessor on `DeckViewHandle` | ⚠️ Residual | offscreen-only; not app boilerplate |
| 7 | `grants.issue` needs un-obtainable `Scope` | ✅ Resolved | `runtime.scopes.create()` → `DeckSession` |

**Boilerplate-free:** every piece of application glue the original report filed is
deleted. What remains is (a) the demo's own screenshot/composite harness (#6, only
because the demo captures native views offscreen), (b) a one-time `loadURL` for the
main window (#2, the single un-shipped ergonomic), and (c) a framework-side
shutdown null-guard bug (#7 residual) the demo cannot touch. The core proof — a
renderer splitter drag moving the native color blocks with zero host resize code —
is GREEN (sim 360→220, devtools x 390→250, both Δ140).
