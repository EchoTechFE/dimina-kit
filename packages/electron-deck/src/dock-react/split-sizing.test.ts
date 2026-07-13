/**
 * Contract spec for the pure split-sizing arithmetic (`./split-sizing`, no
 * react import — runs under the node `vitest.config.ts` suite). Imported
 * directly from `./split-sizing.js`, mirroring `drag-redock.test.ts`.
 *
 * `buildSetLayoutMap`'s `measured` parameter guards Bug #3: right after a
 * `<Group>` cold-mounts a `minPx`/`fixedPx` child whose content is itself a
 * nested split, react-resizable-panels' own mount-time px→percentage
 * conversion for that child can land on a degenerate ratio (reproduced with a
 * real Electron renderer: the pinned child grabbing ~99% while its lone
 * flexible sibling collapsed to the floor) — and because `buildSetLayoutMap`
 * used to unconditionally trust the live-reported percentage for a fixed
 * child, that wrong value was perpetuated forever (nothing else ever
 * re-measures). `measured` lets the caller supply a REAL container pixel
 * measurement so a fixed child's target percentage can be derived directly
 * instead, bypassing an untrustworthy live value.
 */
import { describe, it, expect } from 'vitest'
import {
	buildSetLayoutMap,
	layoutsEquivalent,
	toPercentages,
	computeFlexiblePercentages,
	flexibleFloor,
	clampFlexibleWeights,
	incomingFlexRatios,
	type MeasuredContainer,
} from './split-sizing.js'
import type { SizeConstraint } from '../layout/index.js'

const CHILD_IDS = ['fixed', 'flex'] as const
const MIN_PX_CONSTRAINTS: (SizeConstraint | null)[] = [{ minPx: 300 }, null]
const FIXED_PX_CONSTRAINTS: (SizeConstraint | null)[] = [{ fixedPx: 300 }, null]

describe('buildSetLayoutMap — backward compatibility (no `measured` param)', () => {
	it('trusts the live percentage for a minPx child, unchanged from before', () => {
		const live = { fixed: 40, flex: 60 }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], MIN_PX_CONSTRAINTS, live)
		expect(result).toEqual({ fixed: 40, flex: 60 })
	})

	it('trusts the live percentage for a fixedPx child, unchanged from before', () => {
		const live = { fixed: 25, flex: 75 }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], FIXED_PX_CONSTRAINTS, live)
		expect(result).toEqual({ fixed: 25, flex: 75 })
	})

	it('bails (null) when a fixed child has no live percentage — no `measured` fallback available', () => {
		const live = { flex: 75 } // missing 'fixed'
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], MIN_PX_CONSTRAINTS, live)
		expect(result).toBeNull()
	})
})

describe('buildSetLayoutMap — `measured` param (Bug #3 defense)', () => {
	it('a fixedPx child is ALWAYS computed from the measurement, ignoring a wrong live value', () => {
		// live reports a degenerate 99/1 split (the cold-mount bug); the real
		// container is 1000px wide and the child is locked to 300px = 30%.
		const live = { fixed: 99, flex: 1 }
		const measured: MeasuredContainer = { containerPx: 1000, trustLiveForMinPx: false }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], FIXED_PX_CONSTRAINTS, live, measured)
		expect(result!.fixed).toBeCloseTo(30, 6)
		expect(result!.flex).toBeCloseTo(70, 6)
	})

	it('a fixedPx child is computed from the measurement even when trustLiveForMinPx is true', () => {
		// trustLiveForMinPx only governs minPx children — fixedPx is never
		// legitimately anything but its exact px value.
		const live = { fixed: 99, flex: 1 }
		const measured: MeasuredContainer = { containerPx: 1000, trustLiveForMinPx: true }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], FIXED_PX_CONSTRAINTS, live, measured)
		expect(result!.fixed).toBeCloseTo(30, 6)
		expect(result!.flex).toBeCloseTo(70, 6)
	})

	it('a minPx child is computed from the measurement when trustLiveForMinPx is false (fresh remount)', () => {
		const live = { fixed: 99, flex: 1 } // the cold-mount collapse
		const measured: MeasuredContainer = { containerPx: 1000, trustLiveForMinPx: false }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], MIN_PX_CONSTRAINTS, live, measured)
		expect(result!.fixed).toBeCloseTo(30, 6)
		expect(result!.flex).toBeCloseTo(70, 6)
	})

	it('a minPx child KEEPS trusting live when trustLiveForMinPx is true (user may have dragged it wider)', () => {
		// The user dragged the minPx column to 60% — an ongoing sync must not
		// snap it back down to the 30%-of-container floor.
		const live = { fixed: 60, flex: 40 }
		const measured: MeasuredContainer = { containerPx: 1000, trustLiveForMinPx: true }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], MIN_PX_CONSTRAINTS, live, measured)
		expect(result).toEqual({ fixed: 60, flex: 40 })
	})

	it('falls back to trusting live when containerPx is not positive', () => {
		const live = { fixed: 40, flex: 60 }
		const measured: MeasuredContainer = { containerPx: 0, trustLiveForMinPx: false }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], MIN_PX_CONSTRAINTS, live, measured)
		expect(result).toEqual({ fixed: 40, flex: 60 })
	})

	it('still bails (null) when containerPx is not positive AND live is missing the fixed child', () => {
		const live = { flex: 60 }
		const measured: MeasuredContainer = { containerPx: 0, trustLiveForMinPx: false }
		const result = buildSetLayoutMap(CHILD_IDS as unknown as string[], [1, 6], MIN_PX_CONSTRAINTS, live, measured)
		expect(result).toBeNull()
	})

	it('distributes the remaining space across multiple flexible children by weight, after a measured fixed share', () => {
		const ids = ['fixed', 'a', 'b']
		const constraints: (SizeConstraint | null)[] = [{ minPx: 200 }, null, null]
		const live = { fixed: 99, a: 0.5, b: 0.5 }
		const measured: MeasuredContainer = { containerPx: 1000, trustLiveForMinPx: false }
		const result = buildSetLayoutMap(ids, [1, 1, 3], constraints, live, measured)
		// fixed = 200/1000*100 = 20; remaining 80 split 1:3 → 20 / 60.
		expect(result!.fixed).toBeCloseTo(20, 6)
		expect(result!.a).toBeCloseTo(20, 6)
		expect(result!.b).toBeCloseTo(60, 6)
	})
})

// Sanity: the other pure exports are untouched by this change (no regression
// in the surrounding module).
describe('split-sizing — untouched exports', () => {
	it('toPercentages / computeFlexiblePercentages / flexibleFloor / clampFlexibleWeights / incomingFlexRatios / layoutsEquivalent still work', () => {
		expect(toPercentages([1, 1])).toEqual([50, 50])
		expect(computeFlexiblePercentages([1, 6], [{ minPx: 100 }, null])).toEqual(new Map([[1, 100]]))
		expect(flexibleFloor(1)).toBe(1)
		expect(clampFlexibleWeights([0, 100], [null, null])).toEqual([1, 100])
		expect(incomingFlexRatios(['a', 'b'], [null, null], { a: 30, b: 70 })).toEqual({
			indices: [0, 1],
			ratios: [30, 70],
		})
		expect(layoutsEquivalent({ a: 50 }, { a: 50.1 }, ['a'])).toBe(true)
	})
})
