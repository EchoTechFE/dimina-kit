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
//
// Getting that seed is a real IPC round-trip, and it can genuinely fail: the
// main window's `loadFile()` fires synchronously during window construction
// (windows/main-window/create.ts), well before `registerBuiltinModules()`
// registers the `AllocatePlacementGeneration` handler (app.ts) — the
// renderer's first invoke can race ahead of that registration and come back
// rejected ("no handler registered"). A silent local-only fallback on that
// failure would reproduce the exact high-water-mark bug this module exists
// to fix, just triggered by a boot-order race instead of the clock. So a
// failure here is retried a bounded number of times (the registration race
// resolves within a handful of main-process ticks) and, if every attempt
// fails, rejected all the way out — the renderer entry point must not
// render the app on that rejection (see entries/main/main.tsx).
import { allocatePlacementGeneration } from './api/view-api.js'

let placementGeneration = 0
let seeded = false

const ALLOCATE_SEED_ATTEMPTS = 5
const ALLOCATE_SEED_RETRY_DELAY_MS = 50

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve this renderer session's generation seed from main. Callers must
 * await this once, before the first `nextPlacementGeneration()` call — the
 * renderer entry point does this before its first render (see
 * entries/main/main.tsx), so every screen downstream can keep calling
 * `nextPlacementGeneration()` synchronously from a `useState` initializer.
 * Idempotent: a second call after a successful seed is a no-op.
 *
 * Rejects if every retry attempt fails (main never returns a valid seed) —
 * never resolves into a local-only fallback. Callers must not catch this and
 * proceed as if seeded; the whole point is that a from-zero local sequence
 * is unsafe once main has ever accepted a snapshot from a previous session.
 */
export async function ensurePlacementGenerationSeeded(): Promise<void> {
  if (seeded) return
  let lastError: unknown
  for (let attempt = 0; attempt < ALLOCATE_SEED_ATTEMPTS; attempt++) {
    try {
      const seed = await allocatePlacementGeneration()
      if (!Number.isSafeInteger(seed)) {
        throw new Error(`main returned a non-integer placement-generation seed: ${String(seed)}`)
      }
      placementGeneration = seed
      seeded = true
      return
    } catch (err) {
      lastError = err
      if (attempt < ALLOCATE_SEED_ATTEMPTS - 1) await delay(ALLOCATE_SEED_RETRY_DELAY_MS)
    }
  }
  throw new Error(
    `[placement-generation] failed to allocate a generation seed from main after ${ALLOCATE_SEED_ATTEMPTS} attempts`,
    { cause: lastError },
  )
}

export function nextPlacementGeneration(): number {
  return ++placementGeneration
}
