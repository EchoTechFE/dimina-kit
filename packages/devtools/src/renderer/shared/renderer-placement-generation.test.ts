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
 *
 * A second regression (this file's seeding tests): the sequence used to
 * seed itself from `Date.now()` so a fresh renderer session's numbers would
 * "virtually certainly" exceed a previous session's still-standing
 * high-water mark in main. Wall-clock time is not a reliable ordering
 * source — two reloads close enough together (or a clock that jumps
 * backward) can hand out a seed at or below a value main already accepted,
 * permanently freezing every mount's flush thereafter with no way to
 * recover, since each mount's own captured generation is fixed for its
 * life. The fix seeds from main instead (`allocatePlacementGeneration`,
 * derived from main's own high-water mark), resolved once via
 * `ensurePlacementGenerationSeeded()` before the renderer's first render.
 *
 * A third regression (this file's retry/no-fallback tests): the seeding
 * IPC call can genuinely fail — the main window's `loadFile()` fires before
 * main finishes registering the `AllocatePlacementGeneration` handler (see
 * this module's header comment) — and the seed guard used to swallow that
 * into a local-only counter starting at 0, reproducing the exact
 * high-water-mark bug above via a boot-order race instead of the clock.
 * The fix retries a bounded number of times and rejects all the way out on
 * exhaustion; the renderer entry point must not render on that rejection
 * (see entries/main/main.test.ts for that half).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const viewApi = vi.hoisted(() => ({
  allocatePlacementGeneration: vi.fn(() => Promise.reject<number>(new Error('unset mock'))),
}))

vi.mock('./api/view-api.js', () => viewApi)

beforeEach(() => {
  vi.resetModules()
  viewApi.allocatePlacementGeneration.mockReset()
  viewApi.allocatePlacementGeneration.mockImplementation(() => Promise.reject<number>(new Error('unset mock')))
})

describe('nextPlacementGeneration: one strictly increasing sequence shared across every screen', () => {
  it('stays monotonic when calls interleave as if from two independent screens', async () => {
    const { nextPlacementGeneration } = await import('./renderer-placement-generation.js')

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

describe('ensurePlacementGenerationSeeded: main-assigned seed, not wall-clock', () => {
  it('seeds the sequence from allocatePlacementGeneration, not Date.now()', async () => {
    // A seed far below any real Date.now() value pins that the module
    // trusts main's answer rather than folding in the wall clock.
    viewApi.allocatePlacementGeneration.mockResolvedValue(5)
    const { ensurePlacementGenerationSeeded, nextPlacementGeneration } =
      await import('./renderer-placement-generation.js')

    await ensurePlacementGenerationSeeded()

    expect(nextPlacementGeneration()).toBe(6)
  })

  it('reproduces the original bug scenario correctly: a seed below the module-load-time counter still wins, because main is the sole authority', async () => {
    // Simulates two back-to-back renderer reloads racing main's already-
    // elevated high-water mark: main hands out a seed reflecting that
    // high-water mark (e.g. 500), which must be honored exactly — no local
    // fallback counting (e.g. from a wall-clock base) may override it.
    viewApi.allocatePlacementGeneration.mockResolvedValue(500)
    const { ensurePlacementGenerationSeeded, nextPlacementGeneration } =
      await import('./renderer-placement-generation.js')

    await ensurePlacementGenerationSeeded()

    expect(nextPlacementGeneration()).toBe(501)
    expect(nextPlacementGeneration()).toBe(502)
  })

  it('is idempotent: a second call does not re-fetch or reset the counter', async () => {
    viewApi.allocatePlacementGeneration.mockResolvedValue(10)
    const { ensurePlacementGenerationSeeded, nextPlacementGeneration } =
      await import('./renderer-placement-generation.js')

    await ensurePlacementGenerationSeeded()
    nextPlacementGeneration() // 11
    await ensurePlacementGenerationSeeded() // must be a no-op

    expect(viewApi.allocatePlacementGeneration).toHaveBeenCalledTimes(1)
    expect(nextPlacementGeneration()).toBe(12)
  })

})

describe('ensurePlacementGenerationSeeded: retries a failing allocation, never falls back to a local sequence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a transient rejection and seeds from the eventual valid response, not a local-only counter', async () => {
    // The seed IPC can genuinely fail — main's `loadFile()` fires before
    // `registerBuiltinModules()` registers the handler (see this module's
    // header) — so the first attempts here simulate that boot-order race.
    viewApi.allocatePlacementGeneration
      .mockRejectedValueOnce(new Error('no handler registered for allocate-placement-generation'))
      .mockRejectedValueOnce(new Error('no handler registered for allocate-placement-generation'))
      .mockResolvedValueOnce(500)
    const { ensurePlacementGenerationSeeded, nextPlacementGeneration } =
      await import('./renderer-placement-generation.js')

    const seeding = ensurePlacementGenerationSeeded()
    await vi.runAllTimersAsync()
    await seeding

    expect(viewApi.allocatePlacementGeneration).toHaveBeenCalledTimes(3)
    expect(nextPlacementGeneration()).toBe(501)
  })

  it('treats a non-integer resolved value as a failed attempt and retries rather than seeding from it', async () => {
    // `invokeStrict` still resolves whatever main sends back verbatim; a
    // malformed/undefined response must not be trusted as a real seed.
    viewApi.allocatePlacementGeneration
      .mockResolvedValueOnce(undefined as unknown as number)
      .mockResolvedValueOnce(10)
    const { ensurePlacementGenerationSeeded, nextPlacementGeneration } =
      await import('./renderer-placement-generation.js')

    const seeding = ensurePlacementGenerationSeeded()
    await vi.runAllTimersAsync()
    await seeding

    expect(viewApi.allocatePlacementGeneration).toHaveBeenCalledTimes(2)
    expect(nextPlacementGeneration()).toBe(11)
  })

  it('rejects after exhausting every retry, and does NOT mark itself seeded — a later call can still recover', async () => {
    viewApi.allocatePlacementGeneration.mockRejectedValue(new Error('main never responded'))
    const { ensurePlacementGenerationSeeded, nextPlacementGeneration } =
      await import('./renderer-placement-generation.js')

    // Attach the rejection assertion BEFORE advancing timers — awaiting the
    // promise only after runAllTimersAsync would let it reject unobserved in
    // between and flag as an unhandled rejection.
    const seeding = ensurePlacementGenerationSeeded()
    const assertion = expect(seeding).rejects.toThrow(/failed to allocate a generation seed/)
    await vi.runAllTimersAsync()
    await assertion

    const attemptsWhenExhausted = viewApi.allocatePlacementGeneration.mock.calls.length
    expect(attemptsWhenExhausted).toBeGreaterThan(1)

    // The renderer entry point must never have proceeded past this
    // rejection to render on a local-only counter — this call, standing in
    // for a caller-driven retry (e.g. a restart), proves `seeded` was never
    // wrongly latched true by the failed attempt above.
    viewApi.allocatePlacementGeneration.mockReset()
    viewApi.allocatePlacementGeneration.mockResolvedValueOnce(500)
    const retry = ensurePlacementGenerationSeeded()
    await vi.runAllTimersAsync()
    await retry

    expect(nextPlacementGeneration()).toBe(501)
  })
})
