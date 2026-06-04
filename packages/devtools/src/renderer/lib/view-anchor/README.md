# view-anchor

Keep **one** main-process native view (an Electron `WebContentsView`) aligned to **one** DOM element's on-screen rectangle. DOM layout libraries deliberately don't bridge the renderer↔main-process boundary — `view-anchor` is that bridge: it measures a `target` element's `getBoundingClientRect()` and hands the rect to a `publish` callback (which owns the IPC → `setBounds`), re-publishing whenever the element moves or resizes.

The core is engine-agnostic: no React, no Electron, no host layout engine. The only React knowledge lives in `react.ts`.

## Core API

```ts
import { createViewAnchor } from './view-anchor'

const handle = createViewAnchor(target, {
  present: true,                 // attach the native view
  publish: (bounds) => { ... },  // receives the live rect; owns IPC → setBounds
  measure: () => rect | null,    // optional: publish THIS rect instead of target's
})

handle.update({ present, publish }) // re-apply new options (re-publishes immediately)
handle.dispose()                    // stop observing; never publishes again
```

`createViewAnchor(target, opts)` returns a `{ update, dispose }` handle.

- `present: true` → publish `target.getBoundingClientRect()` immediately (x/y rounded; width/height `Math.max(0, Math.round(...))` — x/y may be negative when the element is scrolled off the top/left edge), then re-publish **synchronously** on every `ResizeObserver` tick, `target` `scroll`, and window `resize`. Identical consecutive rects are deduped (see [Publish timing](#publish-timing--synchronous-dedup-coalesced)).
- `present: false` → publish `ZERO` (`{0,0,0,0}`) once and stop observing. The host treats zero area as "detach the child view but keep its `WebContents` alive" — collapse without destroy.
- `update(opts)` re-applies synchronously, resetting the dedup baseline so it always re-publishes once even when the geometry is unchanged (zoom and other non-`Bounds` state ride in the `publish` closure).
- `dispose()` stops observing. After dispose the anchor never publishes again — every emit reads `disposed` synchronously, so there is no queued frame to fire late, and no final ZERO (that's the caller's job; see below).

### Publish timing — synchronous, dedup-coalesced

The follower is a **cross-process** `WebContentsView`: its `setBounds` is composited by the main/browser process, which already lands ~1 frame behind the renderer's own DOM paint (the two processes composite on different frames). During a height / splitter drag this shows as the native overlay trailing the region edge — **worst when the region GROWS**, because the not-yet-followed edge briefly exposes the background behind the placeholder.

The anchor therefore publishes **in the observer tick itself, not via `requestAnimationFrame`**. An earlier version deferred each measure+publish to a RAF (to coalesce a burst into one frame); that stacked a *second*, self-inflicted frame on top of the unavoidable cross-process one, doubling the visible trail. Removing the RAF leaves only the one cross-process frame — masked in practice by painting the placeholder/desk behind the overlay the SAME colour, so the residual gap is invisible.

The anti-flood job the RAF used to do is now served by **`lastPublished` dedup**: a tick whose measured rect is byte-identical (`x,y,width,height`) to the last published rect is dropped. A steady drag re-fires the same final rect → one publish; a same-frame burst of RO + `scroll` + `resize` all measuring the same rect → one publish. `update()`/`apply()` resets the baseline so a state change (e.g. a zoom that only changes the closure, not the rect) still forces one publish. Net: at most one publish per *distinct* rect, with zero added latency.

> Both main-process overlays — the simulator `WebContentsView` and the Chromium DevTools view — bind through this same path, so the latency fix applies to both. See `docs/simulator-render-stack.html` for the simulator's stacking model and the colour-match that hides the residual frame.

### Anchoring a descendant — the `measure` redirect

By default the published rect IS the observed element's rect. When the element the native view must MATCH is not the element whose geometry SIGNALS the moves, pass `measure`: the anchor still observes `target` (ResizeObserver + `scroll`), but publishes `measure()` instead.

This is how the simulator overlays the device bezel's fixed-size inner screen: that screen is centered and scrolled by its column, so a `ResizeObserver` on the screen itself never fires (it doesn't resize; zoom is a CSS transform; the column moves it without resizing it). The anchor instead targets the **scroll container** — which resizes on splitter drag / window resize and fires `scroll` when a tall bezel overflows — and `measure` reports the inner screen's rect. Attaching the anchor to a PARENT of the measured element also guarantees the child is committed before the first measure.

`measure` may return `null` ("not measurable yet" — e.g. the measured descendant hasn't attached): the anchor skips that publish (no ZERO, no stale) and re-measures on the next trigger. `present: false` always publishes ZERO and never routes through `measure`.

### present / ZERO / detach semantics

`present` is the single source of truth for "should the native view be attached", decoupled from DOM lifecycle. `ZERO` is the wire signal that collapses the view. A disposed anchor goes silent rather than emitting ZERO, because `dispose` may run during teardown when emitting would be wrong — so **emit ZERO before disposing** if the element is genuinely disappearing.

## React adapter

```ts
import { useViewAnchor } from './react'

const ref = useViewAnchor({
  present,            // boolean — attach or detach the native view
  publish,            // (bounds) => void — owns the IPC
  measure,            // optional: () => Bounds | null — publish a descendant's rect
  deps: [signature],  // optional: non-DOM state that moves the rect (see below)
})

return <div ref={ref} />
```

`useViewAnchor` returns a ref callback you attach to the anchored DOM element.

- On attach → `createViewAnchor(el, opts)`.
- On `opts`/`deps` change → `update`.
- On detach (`ref → null`) or unmount → publish one ZERO, then `dispose`.

A `ResizeObserver` only sees pure geometry. `deps` covers rect-moving state it can't observe — e.g. a layout-topology signature, the active project path, or a sibling tab's `display:none` toggle. Keep the array length stable across renders (React effect-deps rule).

The adapter emits ZERO on disappearance because the follower is a *main-process* view, not a DOM node: when the anchored element unmounts, the native view would otherwise stay frozen at its last bounds, floating on top of the content. Core `dispose()` is intentionally silent; the adapter routes the disappearance through the already-tested `update({ present: false })` path to collapse the view, exactly once.

**React 18 StrictMode-safe.** The anchor is owned by the ref callback (which fires once on mount and isn't replayed by StrictMode), not by an effect's setup/cleanup. The re-apply effect compares the `[present, publish, ...deps]` tuple and skips when unchanged, so neither the mount run nor StrictMode's effect double-fire re-publishes; and the teardown effect collapses only on a genuine detach (`elRef === null`), so a throwaway dev unmount leaves the live anchor intact instead of stranding the view or emitting a spurious ZERO. A hidden→shown remount publishes the real rect exactly once (no ZERO, no double) — `present` is read render-synchronously so the commit-phase create sees the current value.

## Minimal usage

```tsx
import { useViewAnchor } from '@/lib/view-anchor'
import { publishSimulatorDevtoolsBounds } from '@/shared/api'

function DebugPanel({ visible }: { visible: boolean }) {
  const ref = useViewAnchor({
    present: visible,
    publish: publishSimulatorDevtoolsBounds,
  })
  // The native DevTools view tracks this div; hiding the panel
  // (visible=false, or unmount) collapses it without destroying it.
  return <div ref={ref} className="h-full w-full" />
}
```

## Files

| File | Role |
|---|---|
| `view-anchor.ts` | Imperative core — `createViewAnchor`. No React, no Electron. |
| `react.ts` | React adapter — `useViewAnchor` returning a ref callback. |
| `types.ts` | `Bounds`, `ViewAnchorOptions`, `ViewAnchorHandle`. |
| `index.ts` | Public surface. |

Lift this directory out into its own package and it compiles unchanged: the only runtime deps are `react` (adapter only) and browser APIs (`ResizeObserver` / `getBoundingClientRect`).
