// Single shared counter behind every screen's placement-publisher generation
// (ProjectListScreen, ProjectRuntime — see project-list-screen.tsx /
// project-runtime.tsx). Each screen used to keep its own independent
// module-level counter; that let a project screen mounted (and bumped)
// several times outnumber the list screen's own counter, so navigating back
// to the list screen after two project opens sent main a LOWER generation
// than one it had already accepted. Main's reconciler took that lower value
// as authoritative and permanently rejected every subsequent snapshot as
// stale — freezing native-view placement for the rest of the session. Every
// screen now draws from the same strictly-increasing sequence, so a later
// mount is always numerically later regardless of which screen it is, and
// main's reconciler (placement-reconciler.ts's `setPlacementSnapshot`) hard-
// rejects anything behind its own high-water mark as a genuinely stale,
// already-superseded source rather than treating it as defense-in-depth
// noise.
//
// Seeded from main (`allocatePlacementGeneration`, resolved once via
// `ensurePlacementGenerationSeeded()` before the renderer's first render —
// see entries/main/main.tsx), NOT from `Date.now()`. This module
// re-initializes (the counter resets) on every full renderer reload (dev
// auto-reload, or a crash-recovery reload), but main's high-water mark lives
// in the long-lived main process and is NOT reset by a renderer reload. A
// wall-clock seed is not guaranteed to exceed that still-standing high-water
// mark — two reloads close enough together (faster than the clock's
// resolution, or a clock that jumps backward) can hand out the same or a
// lower seed, and every one of the fresh session's snapshots would then be
// rejected as stale, permanently freezing placement for that session —
// reproducing the exact bug above via a different trigger.
// `allocatePlacementGeneration` fixes this at the source: main derives the
// seed from its own `rendererGeneration` high-water mark
// (placement-reconciler.ts's `allocateGeneration`), so it is guaranteed to
// exceed anything main has ever accepted, independent of wall-clock time.
import { allocatePlacementGeneration } from './api/view-api.js'

let placementGeneration = 0
let seeded = false

/**
 * Resolve this renderer session's generation seed from main. Callers must
 * await this once, before the first `nextPlacementGeneration()` call — the
 * renderer entry point does this before its first render (see
 * entries/main/main.tsx), so every screen downstream can keep calling
 * `nextPlacementGeneration()` synchronously from a `useState` initializer.
 * Idempotent: a second call is a no-op (this module's lifetime is one
 * renderer session; there is only ever one bootstrap to seed).
 */
export async function ensurePlacementGenerationSeeded(): Promise<void> {
  if (seeded) return
  seeded = true
  // `allocatePlacementGeneration` rides the lenient `invoke` helper, which
  // swallows a main-side failure into `undefined` rather than rejecting —
  // guard explicitly rather than try/catch. Staying on the local-only
  // fallback (counts up from 0) is safe on a fresh main process (whose own
  // high-water mark also starts at 0); a stale main-process reload racing
  // this is not a real scenario since main itself did not respond.
  const seed = await allocatePlacementGeneration()
  if (typeof seed === 'number') placementGeneration = seed
}

export function nextPlacementGeneration(): number {
  return ++placementGeneration
}
