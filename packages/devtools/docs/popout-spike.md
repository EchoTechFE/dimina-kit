# Popout spike — live-migrating a DevTools view between windows

**Verdict: GO.** electron-deck's `runtime.view(...).moveTo(win, { rehome: true })`
live-migrates a native `WebContentsView` from the main window into a standalone
"popout" window and back, with the **same `WebContents`** the whole time — no
reload, page document context preserved. Verified on real Electron 41.2.1.

This is the first production-shaped consumer of deck's most expensive and (until
now) unconsumed capability: cross-window `moveTo` + `Scope.adopt` rehome (the
donor-scope bug fixed in `79d60827`).

## What was proven

Harness: `packages/devtools/spike/popout/harness.mjs` — a real Electron main
process that boots a deck app (`startElectronDeck`), creates one migratable view,
and drives the full popout / pop-back cycle. Run it:

```sh
cd packages/devtools
pnpm spike:popout           # prints POPOUT_SPIKE_RESULT={...}
pnpm spike:popout --shots   # also writes spike/popout/shots/*.png (gitignored)
```

The view loads `view.html`, which on each **load** stamps a unique
`window.__popoutMarker` and starts a `setInterval` counter (`window.__tick`).
A reload would regenerate the marker and reset the counter to ~0, so both are
falsifiable, live proofs that the document survived the migration. At every step
the harness samples `webContents.id`, the marker, and the tick.

Latest run (`pnpm spike:popout`, all steps `ok:true`):

| step | wc.id | marker | tick |
| --- | --- | --- | --- |
| docked-in-main | 3 | `marker-…` | 10 |
| **popped-out** (moveTo popout, rehome) | **3** (stable) | **unchanged** | 10 → 19 |
| **popped-back** (moveTo main, rehome) | **3** (stable) | **unchanged** | 19 → 25 |
| view-survives-popout-window-close | 3 (alive) | unchanged | — |

Three independent invariants held across both migrations:

1. **`webContents.id` never changed** — same native object, not a re-created view.
2. **Per-load marker unchanged** — no reload regenerated it.
3. **Live counter advanced monotonically** (never reset to 0) — the page's own
   event loop kept running through the move.

Plus a **lifetime** check: after `rehome:true` back to the main window, closing
the popout window does **not** tear the view down (it now lives under the main
window's scope). This is the `adopt` re-parenting working as designed.

Screenshot佐证 (`--shots`): `2-popped-out.png` shows the view rendering counter
`19` with the same marker while hosted by the popout window — captured via
`handle.capturePage()` (deck's own pass-through).

## deck API used (no gaps in the migration primitive itself)

```ts
const handle = runtime.view({ source: { file: VIEW_HTML } })  // owns 1 WCV
handle.placeIn(runtime.mainWindow, { zone: 0 })               // dock home
handle.applyPlacement({ visible: true, bounds })              // geometry

await handle.moveTo(popoutWindow, { zone: 0, rehome: true })  // POP OUT
await handle.moveTo(runtime.mainWindow, { zone: 0, rehome: true }) // POP BACK

handle.webContents          // stable native WebContents accessor
await handle.capturePage()  // screenshot pass-through
```

The migration primitive is complete, atomic (rolls back on a failed dest commit),
and serialized per view (the migration lock). Both `runtime.mainWindow` and
`runtime.windows.create()` windows are framework-tracked substrates, so they are
valid `placeIn` / `moveTo` targets out of the box.

## Gaps to get from spike → production in DevTools

These are NOT deck-primitive bugs; they are the integration surface a real
"pop out this panel" button needs. Listed by where the work lives.

### G1 — DevTools' right-side panels are React tabs, not deck views (biggest)

The spike migrates a deck-managed top-level `WebContentsView`. But the actual
DevTools **right-side panels** (WXML / AppData / Storage; see
`src/main/ipc/panels.ts`) are **React components inside the main renderer**, not
separate WebContents. They cannot be `moveTo`'d — there is nothing native to
migrate. To pop one out you must **first** carve the panel into its own
`runtime.view({ source })` (its own WebContents/route), then deck can migrate it.

The DevTools **simulator DevTools (Chromium inspector)** and the **Monaco editor**
overlays ARE already separate `WebContentsView`s — but they are managed by the
**bespoke `view-manager.ts`** (`new WebContentsView` + `addChildView` /
`removeChildView` directly), **not** through `runtime.view()` handles. So they
cannot be `moveTo`'d either until they are re-homed onto deck view handles.

**→ The real prerequisite is adopting `runtime.view()` as the ownership model for
the overlays in `view-manager.ts`.** That is the one substantial piece of product
work; the migration itself is free once a panel is a deck view.

### G2 — Renderer-side slot wiring for the popout window

The spike drives geometry from the **main process** (`handle.applyPlacement`).
In production the popout window's own renderer must own its layout. deck already
provides the slot-token + `createDeckLayoutClient` (`@dimina-kit/electron-deck/client`)
path: an anchored `placeIn`/`moveTo` (`{ anchor }`) mints a slot grant the dest
renderer uses to `place` the view against a DOM anchor. The spike skipped anchors
(main-process geometry) to isolate the migration. Production needs: a popout host
renderer that renders a placeholder `<div>`, subscribes via the layout client,
and the `moveTo({ anchor })` re-issues the grant to the dest window. **No missing
API — just unbuilt UI glue.**

### G3 — Capability grants do NOT follow the move (by design — gap#2)

`moveTo` migrates **display** and (with rehome) **lifetime**, but explicitly NOT
capability grants (`view-handle.ts` gap#2). If the popped-out panel needs
privileged `layout.*` commands, the **dest window's control layer must issue its
own grant** (`runtime.grants.issue(destControlWc, …)`). For a popped-out DevTools
panel that needs to keep talking to the simulator/CDP, the host has to re-grant on
arrival. Not hard, but easy to forget — the panel would silently lose privileges
otherwise.

### G4 — Popout window chrome / UX is unspecified

The spike's popout is a bare `windows.create({ source: host.html })`. Production
needs: a titled frame, remembered position/size, a "dock back" affordance, and a
close-decider (`DeckWindow.onClose`) so closing the popout pops the panel home
instead of destroying its view. deck has `onClose` for exactly this; the policy is
product work.

### G5 — Entry point

This spike has no UI entry (it is a scripted harness). A production popout needs a
menu item / panel-header button / shortcut wired to `handle.moveTo(...)`. Trivial
once G1 lands.

## Risks / sharp edges observed

- **`applyPlacement` after `moveTo`**: the handle drops place frames *while a move
  is in flight* (the `migrating` flag), so the dest renderer (or host) must
  re-apply geometry *after* `moveTo` resolves — the spike does exactly this
  (`await moveTo(...)` then `applyPlacement`). Document this for the slot client.
- **Baseline timing**: the migrated WebContents keeps running, but a freshly
  `placeIn`'d view needs its content to finish loading before its first sample —
  a harness-only concern (settled with a delay), not a migration issue.

## Bottom line

The deck live-migrate primitive is **production-ready and works on real Electron**.
The gap to a shipping "pop out panel" feature in DevTools is **entirely on the
DevTools side** (G1: move overlay ownership from the bespoke `view-manager` onto
`runtime.view()` handles; G2/G4/G5: renderer slot glue + window UX + entry). No
deck capability is missing for the core migration.
