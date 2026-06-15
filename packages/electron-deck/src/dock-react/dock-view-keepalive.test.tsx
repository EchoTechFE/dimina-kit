/**
 * FAILING TDD spec (red phase) for the DOM-panel KEEPALIVE contract (gap A3).
 *
 * Mirrors the harness/fixtures of `dock-view.test.tsx`. These tests describe the
 * DESIRED behavior of `<DockView>` after keepalive lands; they FAIL against the
 * current impl, where `renderActiveBody` renders ONLY the active panel's body and
 * UNMOUNTS every inactive DOM panel.
 *
 * ── THE CONTRACT (what the implementer must honor) ──────────────────────────
 *
 * 1. DOM-panel keepalive: every DOM panel in a tab group stays MOUNTED across tab
 *    switches; inactive ones are visually HIDDEN (not unmounted). Switching
 *    A→B→A must NOT remount A's subtree — its component instance + DOM node
 *    persist, so a mount-counter inside the body increments EXACTLY ONCE across
 *    the whole A→B→A round-trip. Local state (scroll, expanded rows) survives.
 *
 * 2. Native panels are EXEMPT: a panel whose registry descriptor `kind ===
 *    'native'` is rendered via `NativeSlot` and stays ACTIVE-ONLY — it mounts
 *    only when active and unmounts (firing `bindNativeSlot(panelId, null)`) when
 *    deactivated. Keepalive must NOT keep native slots mounted while hidden (that
 *    would collapse the WebContentsView rect).
 *
 * 3. Active signalling: the host must be told, per rendered DOM panel, whether it
 *    is the currently-active tab, and that signal must UPDATE when the active tab
 *    changes — WITHOUT remounting the panel. This lets a consumer run
 *    "on activation" side effects (data refresh) without relying on mount.
 *
 * ── ASSUMED `renderDomPanel` SIGNATURE (implementer: please honor) ───────────
 *
 * The current signature is `renderDomPanel(panelId: string)`. The active-signal
 * tests below assume the keepalive impl extends it to:
 *
 *     renderDomPanel(panelId: string, opts: { active: boolean }): ReactNode
 *
 * where `opts.active` is `true` iff `panelId` is its group's active tab, and is
 * RE-EVALUATED (the renderer re-invoked with the new `opts.active`) on every
 * activation change — without remounting the kept-alive subtree. If you choose a
 * different shape (e.g. an `isActive` React context the body reads), keep the
 * OBSERVABLE behavior these tests pin: a kept-alive body can detect becoming
 * active/inactive without being remounted, and the host receives the active flag.
 * The mount-counter tests are signature-AGNOSTIC and remain the load-bearing
 * keepalive proof.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
	createLayoutModel,
	createPanelRegistry,
	setActive,
	type LayoutTree,
	type LayoutModel,
	type PanelRegistry,
} from '../layout/index.js'

import { DockView } from './index.js'

// ───────────────────────── fixtures ─────────────────────────

/** One group holding three DOM panels (a, b, c); a active. */
function makeDomGroupTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'column',
			sizes: [1],
			children: [
				{ kind: 'tabs', id: 'g', panels: ['a', 'b', 'c'], active: 'a' },
			],
		},
	}
}

/** A group holding one native + one dom panel, native active. */
function makeNativeTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'column',
			sizes: [1],
			children: [
				{ kind: 'tabs', id: 'g', panels: ['nativeCam', 'logs'], active: 'nativeCam' },
			],
		},
	}
}

function makeRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	reg.register({ kind: 'dom', id: 'a', title: 'A' })
	reg.register({ kind: 'dom', id: 'b', title: 'B' })
	reg.register({ kind: 'dom', id: 'c', title: 'C' })
	reg.register({ kind: 'dom', id: 'logs', title: 'Logs' })
	reg.register({
		kind: 'native',
		id: 'nativeCam',
		title: 'Camera',
		nativeRef: { id: 'native-cam-handle' },
	})
	return reg
}

/**
 * A DOM body that records, into the shared `mounts` map, exactly how many times
 * its component instance MOUNTED. Keepalive ⇒ a kept body mounts once and never
 * remounts on a tab round-trip, so its counter stays at 1. Also exposes a
 * stateful input whose value survives a round-trip iff the instance was kept.
 */
function makeCountingRenderer() {
	const mounts = new Map<string, number>()

	function Body({ panelId }: { panelId: string }): ReactNode {
		// Increment the mount counter exactly once per real mount.
		useEffect(() => {
			mounts.set(panelId, (mounts.get(panelId) ?? 0) + 1)
			// no cleanup-decrement: we count MOUNTS, not live instances.
		}, [panelId])
		// Local component state: a controlled input. If the instance is kept
		// alive across a tab round-trip, the typed value persists; a remount
		// resets it to ''.
		const [val, setVal] = useState('')
		return (
			<div data-test-body={panelId}>
				<input
					data-test-input={panelId}
					value={val}
					onChange={(e) => setVal(e.target.value)}
				/>
			</div>
		)
	}

	const renderDomPanel = (panelId: string): ReactNode => (
		<Body key={panelId} panelId={panelId} />
	)

	return { mounts, renderDomPanel }
}

function renderDock(opts: {
	model: LayoutModel
	registry: PanelRegistry
	// Loosely typed: the keepalive impl is expected to extend the signature to
	// `(id, { active }) => ReactNode`; the prop type is still the 1-arg form on
	// HEAD, so we widen here so the test compiles against either shape.
	renderDomPanel: (...args: any[]) => ReactNode
	bindNativeSlot?: (id: string, el: HTMLElement | null) => void
}) {
	const bindNativeSlot = opts.bindNativeSlot ?? (() => {})
	return render(
		<DockView
			model={opts.model}
			registry={opts.registry}
			renderDomPanel={opts.renderDomPanel as any}
			bindNativeSlot={bindNativeSlot}
		/>,
	)
}

beforeEach(() => {
	cleanup()
})

// ───────────────────────── tests ─────────────────────────

describe('<DockView> DOM-panel keepalive (A3)', () => {
	// BUG (A3): `renderActiveBody` renders ONLY the active panel — inactive DOM
	// panels are UNMOUNTED. So switching to an inactive tab MOUNTS its body fresh
	// every time; there is no kept-alive instance. This test pins that every DOM
	// panel in the group is mounted ONCE up-front (keepalive), so b and c each have
	// a mount counter of 1 even though only `a` is active. On HEAD, b and c are not
	// rendered at all (counter undefined / 0) → FAILS.
	it('mounts every DOM panel in the group once up-front (inactive ones kept alive)', () => {
		const { mounts, renderDomPanel } = makeCountingRenderer()
		renderDock({
			model: createLayoutModel(makeDomGroupTree()),
			registry: makeRegistry(),
			renderDomPanel,
		})

		// active panel mounted.
		expect(mounts.get('a')).toBe(1)
		// inactive panels are KEPT ALIVE — they mount too (just hidden).
		expect(mounts.get('b')).toBe(1)
		expect(mounts.get('c')).toBe(1)
	})

	// BUG (A3): the core regression. Switch a→b→a. With keepalive, `a`'s instance
	// is never unmounted, so its mount counter stays at 1 across the whole
	// round-trip. On HEAD, switching away UNMOUNTS `a` and switching back MOUNTS a
	// fresh `a` → counter becomes 2 → FAILS. This is the bug that loses scroll
	// position / expanded rows on a tab round-trip.
	it('A→B→A does NOT remount A (mount counter stays 1 across the round-trip)', () => {
		const model = createLayoutModel(makeDomGroupTree())
		const { mounts, renderDomPanel } = makeCountingRenderer()
		renderDock({ model, registry: makeRegistry(), renderDomPanel })

		expect(mounts.get('a')).toBe(1)

		// a → b
		act(() => { model.apply((t) => setActive(t, 'g', 'b')) })
		// b → a (back)
		act(() => { model.apply((t) => setActive(t, 'g', 'a')) })

		// A was kept alive the whole time: it must NOT have remounted.
		expect(mounts.get('a')).toBe(1)
	})

	// BUG (A3): local React state in a DOM panel is destroyed on a tab round-trip
	// because the subtree remounts. With keepalive the instance persists, so a
	// value typed into A's input survives A→B→A. On HEAD the remount resets the
	// input to '' → FAILS. This is the user-visible symptom (scroll position /
	// form state lost) stated in concrete, assertable terms.
	it('preserves a DOM panel’s local state (typed input) across A→B→A', () => {
		const model = createLayoutModel(makeDomGroupTree())
		const { renderDomPanel } = makeCountingRenderer()
		const { container } = renderDock({ model, registry: makeRegistry(), renderDomPanel })

		// Type into A's input while it is active.
		const inputA = container.querySelector('[data-test-input="a"]') as HTMLInputElement
		expect(inputA).not.toBeNull()
		act(() => { fireEvent.change(inputA, { target: { value: 'scroll-pos-42' } }) })

		// a → b → a
		act(() => { model.apply((t) => setActive(t, 'g', 'b')) })
		act(() => { model.apply((t) => setActive(t, 'g', 'a')) })

		// The SAME instance is still mounted: the typed value survived.
		const inputAfter = container.querySelector('[data-test-input="a"]') as HTMLInputElement
		expect(inputAfter).not.toBeNull()
		expect(inputAfter.value).toBe('scroll-pos-42')
	})

	// BUG (A3): keepalive must HIDE the inactive bodies, not show them all at once
	// (that would stack panels visually + leak pointer events). Both the active and
	// the kept-alive inactive bodies are in the DOM, but only the active one is
	// visible. We assert via inline style: the active body is not display:none; the
	// inactive bodies ARE display:none (or aria-hidden). On HEAD inactive bodies are
	// absent from the DOM entirely → the `querySelector` for `b`/`c` is null → the
	// "kept but hidden" assertion FAILS.
	it('keeps inactive DOM bodies in the DOM but visually hidden', () => {
		const model = createLayoutModel(makeDomGroupTree())
		const { renderDomPanel } = makeCountingRenderer()
		const { container } = renderDock({ model, registry: makeRegistry(), renderDomPanel })

		// All three bodies are present (kept alive).
		const bodyA = container.querySelector('[data-deck-panel-body="a"]') as HTMLElement | null
		const bodyB = container.querySelector('[data-deck-panel-body="b"]') as HTMLElement | null
		const bodyC = container.querySelector('[data-deck-panel-body="c"]') as HTMLElement | null
		expect(bodyA, 'active body a present').not.toBeNull()
		expect(bodyB, 'inactive body b kept in DOM').not.toBeNull()
		expect(bodyC, 'inactive body c kept in DOM').not.toBeNull()

		// Active body is visible; inactive ones are hidden (display:none or
		// hidden attribute). We accept either common hiding mechanism.
		const isHidden = (el: HTMLElement): boolean =>
			el.style.display === 'none' || el.hasAttribute('hidden')
		expect(isHidden(bodyA!)).toBe(false)
		expect(isHidden(bodyB!)).toBe(true)
		expect(isHidden(bodyC!)).toBe(true)
	})
})

describe('<DockView> active-signalling to the host (A3)', () => {
	// BUG (A3): a kept-alive body must be able to detect that it BECAME active
	// without being remounted (so a consumer can refresh-on-activation). We pin the
	// observable: the host renderer is told which panel is active via the assumed
	// `renderDomPanel(id, { active })` signature, and that flag UPDATES on a tab
	// change. On HEAD, renderDomPanel is called with ONLY `(id)` and only for the
	// active panel, so there is no per-panel active flag and inactive panels are
	// never rendered → asserting `active:false` for a kept inactive panel FAILS.
	it('passes an `active` flag per rendered DOM panel and updates it on tab change', () => {
		const model = createLayoutModel(makeDomGroupTree())
		// Record the latest `active` flag the host saw for each panel.
		const lastActive = new Map<string, boolean>()
		const renderDomPanel = (panelId: string, opts?: { active?: boolean }): ReactNode => {
			lastActive.set(panelId, opts?.active === true)
			return <div data-deck-test-body={panelId} />
		}
		renderDock({ model, registry: makeRegistry(), renderDomPanel })

		// Initially a is active; b and c are kept-alive but inactive.
		expect(lastActive.get('a')).toBe(true)
		expect(lastActive.get('b')).toBe(false)
		expect(lastActive.get('c')).toBe(false)

		// Switch active a → b: the host must be re-told the new flags.
		act(() => { model.apply((t) => setActive(t, 'g', 'b')) })

		expect(lastActive.get('a')).toBe(false)
		expect(lastActive.get('b')).toBe(true)
		expect(lastActive.get('c')).toBe(false)
	})

	// BUG (A3): the active signal must reach the kept-alive component WITHOUT
	// remounting it. We mount a body that records (mount-count, becameActive-count)
	// and assert: a tab round-trip changes the active signal it observes (it sees
	// active flip true→false→true) while its mount count stays 1. On HEAD the only
	// way a body "observes activation" is by being mounted (so mount-count would
	// climb), and inactive bodies are not rendered at all → FAILS.
	it('a kept-alive body observes activation transitions without remounting', () => {
		const model = createLayoutModel(makeDomGroupTree())
		const mounts = new Map<string, number>()
		const activations = new Map<string, number>()

		function Body({ panelId, active }: { panelId: string; active: boolean }): ReactNode {
			useEffect(() => {
				mounts.set(panelId, (mounts.get(panelId) ?? 0) + 1)
			}, [panelId])
			// Count each false→true transition (a "became active" edge), keyed off the
			// `active` prop, WITHOUT remounting.
			const prev = useRef(active)
			useEffect(() => {
				if (active && !prev.current) {
					activations.set(panelId, (activations.get(panelId) ?? 0) + 1)
				}
				prev.current = active
			}, [panelId, active])
			return <div data-deck-test-body={panelId} data-active={active ? 'true' : 'false'} />
		}

		const renderDomPanel = (panelId: string, opts?: { active?: boolean }): ReactNode => (
			<Body key={panelId} panelId={panelId} active={opts?.active === true} />
		)
		renderDock({ model, registry: makeRegistry(), renderDomPanel })

		// a starts active (mounted active=true → no false→true edge counted yet).
		expect(mounts.get('a')).toBe(1)

		// a → b → a. Re-activation of `a` must fire a became-active edge WITHOUT
		// remounting `a`.
		act(() => { model.apply((t) => setActive(t, 'g', 'b')) })
		act(() => { model.apply((t) => setActive(t, 'g', 'a')) })

		expect(mounts.get('a'), 'A kept alive — no remount').toBe(1)
		expect(activations.get('a'), 'A observed a became-active edge on re-activation').toBe(1)
	})
})

describe('<DockView> native panels are EXEMPT from keepalive (A3)', () => {
	// BUG (A3): keepalive must NOT keep native slots mounted while hidden — a
	// hidden native slot would collapse the WebContentsView rect to 0×0. So native
	// panels stay ACTIVE-ONLY: only the active native panel has a slot in the DOM,
	// and deactivating it must UNMOUNT the slot (firing `bindNativeSlot(id, null)`).
	// This guards a wrong keepalive impl that blindly keeps ALL bodies (including
	// native slots) mounted. On HEAD this already passes (native is active-only) —
	// it is a REGRESSION GUARD that the keepalive change must not break native
	// exemption.
	it('keeps only the ACTIVE native slot mounted; deactivation unbinds + removes it', () => {
		const bind = vi.fn()
		const model = createLayoutModel(makeNativeTree())
		const { container } = renderDock({
			model,
			registry: makeRegistry(),
			renderDomPanel: (id: string) => <div data-deck-test-body={id} />,
			bindNativeSlot: bind,
		})

		// nativeCam active → its slot present + bound.
		expect(container.querySelector('[data-deck-native-slot="nativeCam"]')).not.toBeNull()
		bind.mockClear()

		// Switch active away from the native panel to the dom sibling.
		act(() => { model.apply((t) => setActive(t, 'g', 'logs')) })

		// The native slot UNMOUNTED (not kept alive) → unbound + removed.
		const nullCall = bind.mock.calls.find((c) => c[0] === 'nativeCam' && c[1] === null)
		expect(nullCall, 'native slot unbinds on deactivation (not kept alive)').toBeTruthy()
		expect(
			container.querySelector('[data-deck-native-slot="nativeCam"]'),
			'native slot removed from DOM when inactive (no kept WCV anchor)',
		).toBeNull()
	})
})
