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
// Seeded from `Date.now()` instead of 0: this module re-initializes (the
// counter resets) on every full renderer reload (dev auto-reload, or a
// crash-recovery reload), but main's high-water mark lives in the long-lived
// main process and is NOT reset by a renderer reload. A fresh post-reload
// session counting up from 0 would then have every one of its (legitimately
// new) snapshots rejected as behind main's still-standing high-water mark,
// permanently freezing placement for that session — reproducing the exact
// bug above via a different trigger. A wall-clock base makes a fresh
// session's numbers virtually certain to exceed any previous session's,
// while still counting up strictly monotonically within the session.
let placementGeneration = Date.now()

export function nextPlacementGeneration(): number {
  return ++placementGeneration
}
