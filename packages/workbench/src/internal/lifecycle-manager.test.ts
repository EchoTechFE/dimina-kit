import { describe, expect, it } from 'vitest'
import {
	LifecycleManager,
	LifecyclePhaseError,
	phaseOrder,
} from './lifecycle-manager.js'
import type { LifecyclePhase } from './lifecycle-manager.js'

const ORDER: readonly LifecyclePhase[] = [
	'init',
	'bind',
	'setup',
	'ready',
	'drain',
	'cleanup',
	'destroy',
	'quit',
]

/**
 * Phase 2 contract tests for the lifecycle phase machine.
 */
describe('phaseOrder', () => {
	it('returns 0..7 for the canonical sequence', () => {
		ORDER.forEach((phase, i) => {
			expect(phaseOrder(phase)).toBe(i)
		})
	})
})

describe('LifecycleManager', () => {
	it('starts in the init phase', () => {
		const lm = new LifecycleManager()
		expect(lm.current).toBe('init')
	})

	it('advances through the canonical sequence one phase at a time', () => {
		const lm = new LifecycleManager()
		for (let i = 1; i < ORDER.length; i++) {
			const next = ORDER[i] as LifecyclePhase
			lm.enter(next)
			expect(lm.current).toBe(next)
		}
	})

	it('throws LifecyclePhaseError when skipping a middle phase (init → setup)', () => {
		const lm = new LifecycleManager()
		expect(() => lm.enter('setup')).toThrow(LifecyclePhaseError)
	})

	it('throws LifecyclePhaseError when skipping multiple phases (init → ready)', () => {
		const lm = new LifecycleManager()
		expect(() => lm.enter('ready')).toThrow(LifecyclePhaseError)
	})

	it('throws LifecyclePhaseError on backwards transitions (setup → init)', () => {
		const lm = new LifecycleManager()
		lm.enter('bind')
		lm.enter('setup')
		expect(() => lm.enter('init')).toThrow(LifecyclePhaseError)
		expect(() => lm.enter('bind')).toThrow(LifecyclePhaseError)
	})

	it('throws LifecyclePhaseError on re-entering the current phase (target === current)', () => {
		const lm = new LifecycleManager()
		lm.enter('bind')
		expect(() => lm.enter('bind')).toThrow(LifecyclePhaseError)
	})

	it('LifecyclePhaseError exposes the from/to fields', () => {
		const lm = new LifecycleManager()
		try {
			lm.enter('ready')
			throw new Error('expected enter() to throw')
		}
		catch (err) {
			expect(err).toBeInstanceOf(LifecyclePhaseError)
			expect((err as LifecyclePhaseError).from).toBe('init')
			expect((err as LifecyclePhaseError).to).toBe('ready')
		}
	})

	it('after a failed transition, current does not advance', () => {
		const lm = new LifecycleManager()
		expect(() => lm.enter('setup')).toThrow(LifecyclePhaseError)
		expect(lm.current).toBe('init')
	})

	it('assertAtLeast(p) does nothing when current === p', () => {
		const lm = new LifecycleManager()
		expect(() => lm.assertAtLeast('init')).not.toThrow()
	})

	it('assertAtLeast(p) does nothing when current > p', () => {
		const lm = new LifecycleManager()
		lm.enter('bind')
		lm.enter('setup')
		expect(() => lm.assertAtLeast('init')).not.toThrow()
		expect(() => lm.assertAtLeast('bind')).not.toThrow()
	})

	it('assertAtLeast(p) throws when current < p', () => {
		const lm = new LifecycleManager()
		expect(() => lm.assertAtLeast('setup')).toThrow()
		expect(() => lm.assertAtLeast('ready')).toThrow()
	})
})
