/**
 * Regression: ProjectListScreen and ProjectRuntime each used to keep their
 * own independent `let placementGeneration = 0` module-level counter. A
 * project screen mounted (and bumped) twice, then navigating back to the
 * list screen, sent main a generation LOWER than one it had already
 * accepted from the project screen — main's reconciler treats a lower
 * generation as stale and rejects it, permanently freezing native-view
 * placement (see placement-reconciler.test.ts's guard coverage for the
 * main-side half of this).
 *
 * `nextPlacementGeneration()` is the fix: one shared sequence, so calls
 * interleaved across "screens" still come out strictly increasing.
 */
import { describe, it, expect } from 'vitest'
import { nextPlacementGeneration } from './renderer-placement-generation.js'

describe('nextPlacementGeneration: one strictly increasing sequence shared across every screen', () => {
  it('stays monotonic when calls interleave as if from two independent screens', () => {
    const listScreenMount1 = nextPlacementGeneration()
    const projectScreenMount1 = nextPlacementGeneration()
    const projectScreenMount2 = nextPlacementGeneration() // reopened a project
    const listScreenMount2 = nextPlacementGeneration() // navigated back to the list

    expect(listScreenMount1).toBeLessThan(projectScreenMount1)
    expect(projectScreenMount1).toBeLessThan(projectScreenMount2)
    // The regression: under two independent per-screen counters, this value
    // would have been 2 (the list screen's own second call) — lower than
    // projectScreenMount2's 3, and rejected by main as stale.
    expect(
      listScreenMount2,
      'a later mount, regardless of which screen, must be numerically later than every earlier mount',
    ).toBeGreaterThan(projectScreenMount2)
  })
})
