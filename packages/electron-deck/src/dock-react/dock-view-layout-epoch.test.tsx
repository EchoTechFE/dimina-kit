/**
 * Contract spec for `useDockLayoutEpoch()` + the epoch React context `<DockView>`
 * provides to its rendered panel subtree.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * `@dimina-kit/electron-deck/dock-react` exports `useDockLayoutEpoch(): number`.
 *  - It returns the CURRENT dock-layout epoch, equal to the underlying
 *    `LayoutModel`'s revision.
 *  - `<DockView>` provides that value to its panel subtree via React context.
 *  - `createLayoutModel` starts revision at 0; each successful `model.apply(...)`
 *    bumps it by 1; subscribe does NOT replay. So the first frame reports epoch 0,
 *    the first `apply` makes it 1, the next makes it 2.
 *  - Called OUTSIDE a `<DockView>` provider the hook returns the constant 0.
 *
 * These assertions are driven through a probe component that `DockView` renders as
 * a DOM panel body (`renderDomPanel`). The probe calls `useDockLayoutEpoch()` and
 * records every value it observes. External `model.apply(...)` is wrapped in
 * `act()` so the resulting re-render is flushed before assertions.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import {
	createLayoutModel,
	createPanelRegistry,
	type LayoutTree,
	type PanelRegistry,
} from '../layout/index.js'
import { DockView, useDockLayoutEpoch } from './index.js'

// ───────────────────────── fixtures ─────────────────────────

/** A single tab group holding one dom panel. Identity-applies bump the revision. */
function makeTree(): LayoutTree {
	return {
		version: 1,
		root: { kind: 'tabs', id: 'g0', panels: ['probe'], active: 'probe' },
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	reg.register({ kind: 'dom', id: 'probe', title: 'Probe' })
	return reg
}

/** Probe component: renders the current epoch as a `data-epoch` attribute and
 *  also pushes each observed value into `sink`. */
function EpochProbe({ sink }: { sink: number[] }) {
	const epoch = useDockLayoutEpoch()
	sink.push(epoch)
	return <div data-epoch={String(epoch)}>epoch:{epoch}</div>
}

beforeEach(() => {
	cleanup()
})

// ───────────────────────── tests ─────────────────────────

describe('useDockLayoutEpoch inside <DockView>', () => {
	it('reports epoch 0 on first frame and bumps on each external model.apply', () => {
		const sink: number[] = []
		const model = createLayoutModel(makeTree())
		const { container } = render(
			<DockView
				model={model}
				registry={makeRegistry()}
				renderDomPanel={() => <EpochProbe sink={sink} />}
				bindNativeSlot={() => {}}
			/>,
		)

		const read = () =>
			container.querySelector('[data-epoch]')!.getAttribute('data-epoch')

		// First frame: revision starts at 0.
		expect(read()).toBe('0')
		expect(sink[sink.length - 1]).toBe(0)

		// First successful identity apply → revision 1.
		act(() => {
			model.apply((t) => t)
		})
		expect(read()).toBe('1')
		expect(sink[sink.length - 1]).toBe(1)

		// Second identity apply → revision 2.
		act(() => {
			model.apply((t) => t)
		})
		expect(read()).toBe('2')
		expect(sink[sink.length - 1]).toBe(2)
	})
})

describe('useDockLayoutEpoch outside a provider', () => {
	it('returns the constant 0 with no <DockView> ancestor', () => {
		const sink: number[] = []
		const { container } = render(<EpochProbe sink={sink} />)
		expect(container.querySelector('[data-epoch]')!.getAttribute('data-epoch')).toBe('0')
		expect(sink[sink.length - 1]).toBe(0)
	})
})
