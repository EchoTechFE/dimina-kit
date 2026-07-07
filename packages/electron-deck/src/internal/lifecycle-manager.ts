/**
 * Lifecycle phase machine.
 *
 * 8 个 phase 严格递增，无跳跃：
 *   init → bind → setup → ready → drain → cleanup → destroy → quit
 *
 * @internal
 */

export type LifecyclePhase =
	| 'init'
	| 'bind'
	| 'setup'
	| 'ready'
	| 'drain'
	| 'cleanup'
	| 'destroy'
	| 'quit'

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

export class LifecyclePhaseError extends Error {
	readonly from: LifecyclePhase
	readonly to: LifecyclePhase
	constructor(from: LifecyclePhase, to: LifecyclePhase) {
		super(`Illegal lifecycle transition: ${from} → ${to}`)
		this.name = 'LifecyclePhaseError'
		this.from = from
		this.to = to
	}
}

export function phaseOrder(p: LifecyclePhase): number {
	const idx = ORDER.indexOf(p)
	if (idx === -1) throw new Error(`unknown lifecycle phase: ${String(p)}`)
	return idx
}

export class LifecycleManager {
	current: LifecyclePhase = 'init'

	enter(to: LifecyclePhase): void {
		const fromOrder = phaseOrder(this.current)
		const toOrder = phaseOrder(to)
		if (toOrder !== fromOrder + 1) {
			throw new LifecyclePhaseError(this.current, to)
		}
		this.current = to
	}

	assertAtLeast(p: LifecyclePhase): void {
		if (phaseOrder(this.current) < phaseOrder(p)) {
			throw new Error(
				`lifecycle assertion failed: current=${this.current}, required >= ${p}`,
			)
		}
	}

	/**
	 * Abnormal-path setter：setup throw / 紧急 shutdown 跳过中间 phase 直达
	 * 指定 teardown phase。不做顺序校验，仅 framework 内部使用。
	 *
	 * @internal
	 */
	_force(to: LifecyclePhase): void {
		this.current = to
	}
}
