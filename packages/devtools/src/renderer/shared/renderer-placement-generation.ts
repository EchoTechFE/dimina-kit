// Single shared counter behind every screen's placement-publisher generation
// (ProjectListScreen, ProjectRuntime — see project-list-screen.tsx /
// project-runtime.tsx). Each screen used to keep its own independent
// module-level counter; that let a project screen mounted (and bumped)
// several times outnumber the list screen's own counter, so navigating back
// to the list screen after two project opens sent main a LOWER generation
// than one it had already accepted. Main's reconciler took that lower value
// as authoritative and permanently rejected every subsequent snapshot as
// stale — freezing native-view placement for the rest of the session (see
// placement-reconciler.ts's `setPlacementSnapshot` guard, which is only a
// defense-in-depth backstop for this — the actual fix is that every screen
// now draws from the same strictly-increasing sequence, so a later mount is
// always numerically later regardless of which screen it is).
let placementGeneration = 0

export function nextPlacementGeneration(): number {
  return ++placementGeneration
}
