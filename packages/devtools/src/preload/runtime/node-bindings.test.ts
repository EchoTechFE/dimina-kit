/**
 * Contract: `installNodeBindings` publishes real Node built-ins onto
 * `globalThis.__diminaNodeBindings` for the simulator document to consume
 * (see ./node-bindings.ts's module doc — sandbox:false + contextIsolation:
 * false means this preload shares the page's JS world). Page scripts run
 * inside that same shared world, so a plain `globalThis.__diminaNodeBindings
 * = ...` / `globalThis.__diminaNodeBindings.fs = ...` from mini-program code
 * (or a compromised dependency) would silently swap in a spoofed `fs` module
 * for the vpath resolver and every FileSystemManager handler to trust.
 *
 * The bag itself must be `Object.freeze`d (no member can be reassigned) and
 * the `globalThis` property it lives on must be non-writable (the whole bag
 * cannot be replaced by a later `=` assignment either).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NODE_BINDINGS_GLOBAL } from '../../shared/node-bindings.js'
import { installNodeBindings } from './node-bindings'

function currentBag(): Record<string, unknown> | undefined {
	return (globalThis as Record<string, unknown>)[NODE_BINDINGS_GLOBAL] as Record<string, unknown> | undefined
}

/**
 * Force a clean slate before each test regardless of whether a previous
 * `installNodeBindings()` locked the property down (`defineProperty` can
 * redefine a non-writable-but-configurable property; a fully non-configurable
 * property is left in place — the test then observes the pre-existing bag,
 * which still satisfies every assertion here).
 */
function resetBinding(): void {
	try {
		Object.defineProperty(globalThis, NODE_BINDINGS_GLOBAL, {
			value: undefined,
			writable: true,
			configurable: true,
			enumerable: true,
		})
	} catch {
		// Non-configurable: leave the existing (already-installed, already
		// frozen/non-writable) binding in place.
	}
}

beforeEach(() => {
	resetBinding()
})

afterEach(() => {
	resetBinding()
})

describe('installNodeBindings publishes a read-only, non-replaceable bindings bag', () => {
	it('the published bindings object is frozen — members cannot be reassigned', () => {
		installNodeBindings()
		const bag = currentBag()
		expect(bag, 'installNodeBindings must publish a bindings object').toBeDefined()
		expect(
			Object.isFrozen(bag),
			'globalThis.__diminaNodeBindings must be frozen so page scripts cannot swap out a member (e.g. fs) for a spoofed module',
		).toBe(true)

		const originalFs = bag!.fs
		try {
			bag!.fs = { readFile: () => {} }
		} catch {
			// A frozen object throws on write in strict mode; either way the
			// member below must be unchanged.
		}
		expect(bag!.fs, 'writing to a frozen bindings member must not change it').toBe(originalFs)
	})

	it('the property is non-configurable — delete and defineProperty replacement both fail, the bag survives', () => {
		installNodeBindings()
		const original = currentBag()
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, NODE_BINDINGS_GLOBAL)
		expect(
			descriptor!.configurable,
			'a configurable property can be deleted or redefined by any same-world page script, defeating the non-replaceable contract',
		).toBe(false)

		try {
			delete (globalThis as Record<string, unknown>)[NODE_BINDINGS_GLOBAL]
		} catch {
			// strict mode throws on deleting a non-configurable property
		}
		expect(currentBag(), 'delete must not remove the bindings').toBe(original)

		expect(() =>
			Object.defineProperty(globalThis, NODE_BINDINGS_GLOBAL, { value: { fs: {} }, configurable: true }),
		).toThrow(TypeError)
		expect(currentBag(), 'defineProperty must not replace the bindings').toBe(original)
	})

	it('installNodeBindings is idempotent — a second call leaves the locked binding in place instead of throwing', () => {
		installNodeBindings()
		const first = currentBag()
		expect(() => installNodeBindings()).not.toThrow()
		expect(currentBag()).toBe(first)
	})

	it('globalThis.__diminaNodeBindings cannot be replaced wholesale by a later assignment', () => {
		installNodeBindings()
		const original = currentBag()
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, NODE_BINDINGS_GLOBAL)
		expect(descriptor, `no property descriptor found for globalThis.${NODE_BINDINGS_GLOBAL}`).toBeDefined()
		expect(
			descriptor!.writable,
			'globalThis.__diminaNodeBindings must be defined non-writable so a later `=` assignment cannot overwrite the whole bag',
		).toBe(false)

		try {
			;(globalThis as Record<string, unknown>)[NODE_BINDINGS_GLOBAL] = { fs: {} }
		} catch {
			// non-writable data property: strict mode throws on the assignment.
		}
		expect(currentBag()).toBe(original)
	})
})
