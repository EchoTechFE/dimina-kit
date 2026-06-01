# view-anchor

Keep **one** main-process native view (an Electron `WebContentsView`) aligned to **one** DOM element's on-screen rectangle. DOM layout libraries deliberately don't bridge the renderer↔main-process boundary — `view-anchor` is that bridge: it measures a `target` element's `getBoundingClientRect()` and hands the rect to a `publish` callback (which owns the IPC → `setBounds`), re-publishing whenever the element moves or resizes.

The core is engine-agnostic: no React, no Electron, no host layout engine. The only React knowledge lives in `react.ts`.

## Core API

```ts
import { createViewAnchor } from './view-anchor'

const handle = createViewAnchor(target, {
  present: true,                 // attach the native view
  publish: (bounds) => { ... },  // receives the live rect; owns IPC → setBounds
})

handle.update({ present, publish }) // re-apply new options (re-publishes immediately)
handle.dispose()                    // stop observing; never publishes again
```

`createViewAnchor(target, opts)` returns a `{ update, dispose }` handle.

- `present: true` → publish `target.getBoundingClientRect()` immediately (each field `Math.max(0, Math.round(...))`), then re-publish on every `ResizeObserver` tick and window `resize`, coalesced into one frame via `requestAnimationFrame`.
- `present: false` → publish `ZERO` (`{0,0,0,0}`) once and stop observing. The host treats zero area as "detach the child view but keep its `WebContents` alive" — collapse without destroy.
- `update(opts)` cancels any in-flight RAF, then re-applies synchronously (so a frame queued under the old state can't land late and overwrite the fresh rect).
- `dispose()` stops observing and cancels pending RAF. After dispose the anchor never publishes again — including no final ZERO (that's the caller's job; see below).

### present / ZERO / detach semantics

`present` is the single source of truth for "should the native view be attached", decoupled from DOM lifecycle. `ZERO` is the wire signal that collapses the view. A disposed anchor goes silent rather than emitting ZERO, because `dispose` may run during teardown when emitting would be wrong — so **emit ZERO before disposing** if the element is genuinely disappearing.

## React adapter

```ts
import { useViewAnchor } from './react'

const ref = useViewAnchor({
  present,            // boolean — attach or detach the native view
  publish,            // (bounds) => void — owns the IPC
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

Lift this directory out into its own package and it compiles unchanged: the only runtime deps are `react` (adapter only) and browser APIs (`ResizeObserver` / `requestAnimationFrame` / `getBoundingClientRect`).
