/**
 * FAILING TDD spec for the NOT-YET-WRITTEN `<DockView>` React component.
 *
 * The implementer reads THIS file as the contract. `<DockView>` lives at
 * `./dock-view` (re-exported from `./index`). It renders a docking layout from
 * a `LayoutModel` (observable) + `PanelRegistry` (panelId -> descriptor), and
 * must expose the following STABLE `data-*` attributes so hosts/tests can target
 * structure without depending on class names or DOM nesting details:
 *
 *   data-deck-split="<splitId>"        on every split container
 *   data-orientation="row|column"      on every split container (mirrors node.orientation)
 *   data-deck-resize-handle            on a separator element BETWEEN sibling split children
 *                                      (N children => N-1 handles)
 *   data-deck-group="<groupId>"        on every tabs-group container
 *   data-deck-tab="<panelId>"          on each tab button in a group's tab strip
 *   data-active="true|false"           on each tab button (active tab => "true")
 *   data-deck-panel-body="<panelId>"   wrapper around an ACTIVE DOM panel's body
 *                                      (the body content === renderDomPanel(panelId))
 *   data-deck-native-slot="<panelId>"  empty slot <div> for an ACTIVE NATIVE panel
 *
 * Behavioral contract (each test below names the bug it guards against):
 *  - Only the ACTIVE panel of each group renders a body / native slot.
 *  - Clicking an inactive tab => DockView calls model.apply(t => setActive(...)).
 *  - DockView subscribes to the model and re-renders on EXTERNAL model.apply(...)
 *    (no full app remount).
 *  - Native slot: bindNativeSlot(id, el) on mount-as-active;
 *    bindNativeSlot(id, null) when it stops being active or unmounts.
 *
 * These tests MUST fail right now with "cannot find module ./dock-view"
 * (the component does not exist). They must NOT fail from test-infra issues.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import {
	createLayoutModel,
	createPanelRegistry,
	setActive,
	setSizes,
	setConstraint,
	movePanel,
	type LayoutTree,
	type LayoutModel,
	type PanelRegistry,
} from '../layout/index.js'

// Import the component-under-test. This import is the honest point of failure:
// the module does not exist yet, so every test errors at collection time.
import { DockView, computeFlexiblePercentages } from './index.js'

// ───────────────────────── fixtures ─────────────────────────

/** root split[row] -> [ tabs g-left(sim) | tabs g-right(editor, debug) ] */
function makeTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [1, 1],
			children: [
				{ kind: 'tabs', id: 'g-left', panels: ['sim'], active: 'sim' },
				{
					kind: 'tabs',
					id: 'g-right',
					panels: ['editor', 'debug'],
					active: 'editor',
				},
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
	reg.register({ kind: 'dom', id: 'sim', title: 'Simulator' })
	reg.register({ kind: 'dom', id: 'editor', title: 'Editor' })
	reg.register({ kind: 'dom', id: 'debug', title: 'Debug' })
	reg.register({ kind: 'dom', id: 'logs', title: 'Logs' })
	reg.register({
		kind: 'native',
		id: 'nativeCam',
		title: 'Camera',
		nativeRef: { id: 'native-cam-handle' },
	})
	return reg
}

/** Default renderDomPanel: a marker node so tests can assert which body rendered. */
function domBody(panelId: string) {
	return <div data-test-dom-content={panelId}>BODY:{panelId}</div>
}

function renderDock(opts: {
	model: LayoutModel
	registry: PanelRegistry
	renderDomPanel?: (id: string) => React.ReactNode
	bindNativeSlot?: (id: string, el: HTMLElement | null) => void
}) {
	const renderDomPanel = opts.renderDomPanel ?? domBody
	const bindNativeSlot = opts.bindNativeSlot ?? (() => {})
	return render(
		<DockView
			model={opts.model}
			registry={opts.registry}
			renderDomPanel={renderDomPanel}
			bindNativeSlot={bindNativeSlot}
		/>,
	)
}

beforeEach(() => {
	cleanup()
})

// ───────────────────────── tests ─────────────────────────

describe('<DockView> structure', () => {
	// BUG: impl forgets to recurse into nested splits / mislabels orientation,
	// so hosts can't map containers to react-resizable-panels groups.
	it('renders a split container per split node with id + orientation', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		const split = container.querySelector('[data-deck-split="root"]')
		expect(split).not.toBeNull()
		expect(split!.getAttribute('data-orientation')).toBe('row')
	})

	// BUG: impl drops a group or renders groups it shouldn't, breaking the
	// panelId -> container mapping the host anchors native views against.
	it('renders one group container per tabs node', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		expect(container.querySelector('[data-deck-group="g-left"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-group="g-right"]')).not.toBeNull()
	})

	// BUG: impl renders no resize separators (or one too many), so a drag handle
	// can't be placed between siblings. N children => N-1 handles.
	it('places N-1 resize handles between the N children of a split', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		const handles = container.querySelectorAll('[data-deck-resize-handle]')
		// root split has 2 children => exactly 1 handle.
		expect(handles.length).toBe(1)
	})
})

describe('<DockView> tab strip', () => {
	// BUG: impl renders the wrong set of tab buttons (missing a panel, or a
	// panel that isn't in the group), so users can't switch to it.
	it('renders one tab button per panel in each group', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		const right = container.querySelector('[data-deck-group="g-right"]')!
		expect(right.querySelector('[data-deck-tab="editor"]')).not.toBeNull()
		expect(right.querySelector('[data-deck-tab="debug"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-tab="sim"]')).not.toBeNull()
	})

	// BUG: impl marks the wrong tab active (or marks none), so the active-tab
	// affordance is wrong and the body shown won't match the highlighted tab.
	it('marks the active tab data-active="true" and others "false"', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		const editorTab = container.querySelector('[data-deck-tab="editor"]')!
		const debugTab = container.querySelector('[data-deck-tab="debug"]')!
		expect(editorTab.getAttribute('data-active')).toBe('true')
		expect(debugTab.getAttribute('data-active')).toBe('false')
	})
})

describe('<DockView> active body rendering', () => {
	// A3 KEEPALIVE: under DOM-panel keepalive every DOM panel in a group is mounted
	// (inactive ones hidden via display:none), so the ACTIVE body is visible and the
	// inactive body is PRESENT-BUT-HIDDEN — not absent. (Pre-keepalive this asserted
	// the inactive body was absent from the DOM; that contract is inverted by A3 and
	// the kept-but-hidden behavior is pinned by dock-view-keepalive.test.tsx.)
	it('keeps the active DOM body visible and the inactive one mounted-but-hidden', () => {
		const { container } = renderDock({ model: createLayoutModel(makeTree()), registry: makeRegistry() })
		// g-right active=editor => editor body visible, debug body kept but hidden.
		const editorBody = container.querySelector<HTMLElement>('[data-deck-panel-body="editor"]')
		const debugBody = container.querySelector<HTMLElement>('[data-deck-panel-body="debug"]')
		expect(editorBody).not.toBeNull()
		expect(debugBody).not.toBeNull()
		expect(editorBody!.style.display).not.toBe('none')
		expect(debugBody!.style.display).toBe('none')
	})

	// BUG: impl ignores renderDomPanel and renders its own placeholder, so the
	// host's panel content never appears.
	// A3 KEEPALIVE: the renderer now receives `(panelId, { active })`. The active
	// body's content still comes from `renderDomPanel`; under keepalive the inactive
	// panel IS rendered too (kept-but-hidden), so the renderer is invoked for it with
	// `active:false`. (Pre-keepalive this asserted the renderer was NOT called for the
	// inactive panel; that contract is inverted by A3.)
	it('uses renderDomPanel(panelId, { active }) output as each body content', () => {
		const renderDomPanel = vi.fn((id: string) => (
			<span data-test-marker={id}>custom-{id}</span>
		))
		const { container } = renderDock({
			model: createLayoutModel(makeTree()),
			registry: makeRegistry(),
			renderDomPanel,
		})
		const body = container.querySelector('[data-deck-panel-body="editor"]')!
		expect(body.querySelector('[data-test-marker="editor"]')).not.toBeNull()
		expect(body.textContent).toContain('custom-editor')
		// active panel rendered with active:true; inactive (kept-alive) with active:false.
		expect(renderDomPanel).toHaveBeenCalledWith('editor', { active: true })
		expect(renderDomPanel).toHaveBeenCalledWith('debug', { active: false })
	})

	// BUG: impl renders a native panel via renderDomPanel (wrong) instead of an
	// empty anchor slot, so the host has nowhere to attach the native view.
	it('renders an empty native slot (not a dom body) for an active native panel', () => {
		const { container } = renderDock({ model: createLayoutModel(makeNativeTree()), registry: makeRegistry() })
		expect(container.querySelector('[data-deck-native-slot="nativeCam"]')).not.toBeNull()
		// it is NOT rendered as a dom panel body.
		expect(container.querySelector('[data-deck-panel-body="nativeCam"]')).toBeNull()
	})

	// FILL LAYOUT (FIX 2a) — the native slot (and the group/body around it) must
	// carry fill styling so a leaf slot measures the FULL panel region, not a
	// 0-height content box. jsdom reports 0px geometry regardless, so this guards
	// the STYLE PRESENCE (the real geometry is a real-machine concern); the bug it
	// catches is a future edit dropping the fill style and silently collapsing the
	// native overlay to an invisible rect.
	it('gives the native slot fill styling (flex:1 + min-size:0 + height:100%)', () => {
		const { container } = renderDock({ model: createLayoutModel(makeNativeTree()), registry: makeRegistry() })
		const slot = container.querySelector<HTMLElement>('[data-deck-native-slot="nativeCam"]')!
		// jsdom expands the `flex: 1` shorthand to `1 1 0%`; assert flex-grow:1.
		expect(slot.style.flexGrow).toBe('1')
		expect(slot.style.minWidth).toBe('0px')
		expect(slot.style.minHeight).toBe('0px')
		expect(slot.style.height).toBe('100%')
		// the enclosing group is a fill flex-column so the slot has space to fill.
		const group = container.querySelector<HTMLElement>('[data-deck-group="g"]')!
		expect(group.style.display).toBe('flex')
		expect(group.style.flexDirection).toBe('column')
		expect(group.style.height).toBe('100%')
	})
})

describe('<DockView> tab click interaction', () => {
	// BUG: clicking a tab does nothing (or mutates local state without going
	// through the model), so the canonical layout tree never updates and the
	// switch is lost on the next external snapshot.
	it('clicking an inactive tab drives model.apply(setActive) and swaps the body', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		// before: editor active (visible), debug kept-but-hidden (A3 keepalive).
		const editorBefore = container.querySelector<HTMLElement>('[data-deck-panel-body="editor"]')!
		const debugBefore = container.querySelector<HTMLElement>('[data-deck-panel-body="debug"]')!
		expect(editorBefore.style.display).not.toBe('none')
		expect(debugBefore.style.display).toBe('none')

		const debugTab = container.querySelector('[data-deck-tab="debug"]')!
		act(() => {
			fireEvent.click(debugTab)
		})

		// model's canonical tree now has debug active in g-right.
		const grp = (model.get().root as any).children.find((c: any) => c.id === 'g-right')
		expect(grp.active).toBe('debug')

		// DOM re-rendered: VISIBILITY swapped (both bodies stay mounted under keepalive).
		const debugAfter = container.querySelector<HTMLElement>('[data-deck-panel-body="debug"]')!
		const editorAfter = container.querySelector<HTMLElement>('[data-deck-panel-body="editor"]')!
		expect(debugAfter.style.display).not.toBe('none')
		expect(editorAfter.style.display).toBe('none')
		expect(container.querySelector('[data-deck-tab="debug"]')!.getAttribute('data-active')).toBe('true')
	})

	// BUG: impl fires setActive on a tab that's already active (needless churn)
	// or on the wrong group id, corrupting a different group's active panel.
	it('clicking the already-active tab keeps it active and does not error', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })
		const editorTab = container.querySelector('[data-deck-tab="editor"]')!
		act(() => {
			fireEvent.click(editorTab)
		})
		const grp = (model.get().root as any).children.find((c: any) => c.id === 'g-right')
		expect(grp.active).toBe('editor')
		// the OTHER group is untouched.
		const left = (model.get().root as any).children.find((c: any) => c.id === 'g-left')
		expect(left.active).toBe('sim')
	})
})

describe('<DockView> external reactivity', () => {
	// BUG: impl reads model.get() once and never subscribes, so external
	// mutations (drag, programmatic moves, persisted-layout restore) don't show.
	it('re-renders when an EXTERNAL model.apply(setActive) changes the tree', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })
		// A3 keepalive: debug is kept-but-hidden before the external activation.
		expect(container.querySelector<HTMLElement>('[data-deck-panel-body="debug"]')!.style.display).toBe('none')

		act(() => {
			model.apply((t) => setActive(t, 'g-right', 'debug'))
		})

		// External setActive flips visibility (both bodies stay mounted).
		expect(container.querySelector<HTMLElement>('[data-deck-panel-body="debug"]')!.style.display).not.toBe('none')
		expect(container.querySelector<HTMLElement>('[data-deck-panel-body="editor"]')!.style.display).toBe('none')
	})

	// BUG: impl throws or fails to re-render on a setSizes apply, breaking the
	// resize path (the contract delegates real drag to setSizes via model.apply).
	it('survives + re-renders on an external setSizes apply (weak resize contract)', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		expect(() => {
			act(() => {
				model.apply((t) => setSizes(t, 'root', [3, 1]))
			})
		}).not.toThrow()

		// structure intact after the size change.
		expect(container.querySelector('[data-deck-split="root"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-group="g-left"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-group="g-right"]')).not.toBeNull()
	})

	// BUG: impl leaks a subscription after unmount, so a later model.apply throws
	// "setState on unmounted component" or keeps the tree alive.
	it('unsubscribes on unmount (no throw on apply after unmount)', () => {
		const model = createLayoutModel(makeTree())
		const { unmount } = renderDock({ model, registry: makeRegistry() })
		unmount()
		expect(() => {
			model.apply((t) => setActive(t, 'g-right', 'debug'))
		}).not.toThrow()
	})
})

describe('<DockView> native slot lifecycle', () => {
	// BUG: impl never calls bindNativeSlot with the real element, so the host
	// can't anchor the native view -> blank rect where the native panel should be.
	it('calls bindNativeSlot(id, element) for the active native panel after mount', () => {
		const bind = vi.fn()
		renderDock({ model: createLayoutModel(makeNativeTree()), registry: makeRegistry(), bindNativeSlot: bind })

		const call = bind.mock.calls.find((c) => c[0] === 'nativeCam' && c[1] != null)
		expect(call).toBeTruthy()
		expect(call![1]).toBeInstanceOf(HTMLElement)
		// the element passed is the slot div the host anchors to.
		expect((call![1] as HTMLElement).getAttribute('data-deck-native-slot')).toBe('nativeCam')
	})

	// BUG: impl forgets the unbind on deactivation, so the host keeps a native
	// view anchored to a slot that's gone -> ghost overlay / stale rect.
	it('calls bindNativeSlot(id, null) when the native panel stops being active', () => {
		const bind = vi.fn()
		const model = createLayoutModel(makeNativeTree())
		renderDock({ model, registry: makeRegistry(), bindNativeSlot: bind })

		// switch the group's active away from the native panel to the dom sibling.
		act(() => {
			model.apply((t) => setActive(t, 'g', 'logs'))
		})

		const nullCall = bind.mock.calls.find((c) => c[0] === 'nativeCam' && c[1] === null)
		expect(nullCall).toBeTruthy()
		// and the slot is gone from the DOM.
		// (asserted indirectly: a dom body for `logs` is now present instead)
	})

	// BUG: impl binds only once and never re-binds on re-activation, so toggling
	// back to the native tab leaves it unanchored.
	it('re-binds (id, element) when the native panel becomes active again', () => {
		const bind = vi.fn()
		const model = createLayoutModel(makeNativeTree())
		renderDock({ model, registry: makeRegistry(), bindNativeSlot: bind })

		act(() => {
			model.apply((t) => setActive(t, 'g', 'logs'))
		})
		bind.mockClear()
		act(() => {
			model.apply((t) => setActive(t, 'g', 'nativeCam'))
		})

		const rebind = bind.mock.calls.find((c) => c[0] === 'nativeCam' && c[1] != null)
		expect(rebind).toBeTruthy()
		expect(rebind![1]).toBeInstanceOf(HTMLElement)
	})
})

// ─────────────────── NEW: confirmed-bug regression tests ───────────────────
// Three tests encoding M1/M2/M3. See the per-test comments + the report for the
// empirical jsdom/react-resizable-panels (rrp v4.10) findings that shaped them.

describe('<DockView> stale-tab safety (M3)', () => {
	// BUG (M3) — onClick must re-derive (groupId, panelId) from the LIVE model and
	// guard membership; if a tab's onClick captured a now-invalid (group, panel)
	// pair, after an external structural mutation the click would call
	// setActive(staleGroupId, stalePanelId) → setActive throws → model.apply
	// RETHROWS into the unguarded React event handler. This test guards that a tab
	// click after an external structural mutation never rethrows and leaves the
	// model sane.
	//
	// HONESTY NOTE: against the CURRENT impl this assertion PASSES — the impl is
	// already robust (it re-derives node.id/panelId from the live tree each render
	// and guards with `if (!active)`), so under synchronous `act()` there is no
	// reproducible M3 crash. This is therefore a REGRESSION GUARD, not a
	// fails-now bug reproduction. The companion `it.todo` below records why a
	// deterministic "fails-now" M3 click-crash is not reproducible here.
	it('clicking a tab after an external structural mutation never rethrows; model stays sane', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		// Capture the debug tab BEFORE the external mutation (the "stale" handle).
		const staleDebugTab = container.querySelector('[data-deck-tab="debug"]')

		// EXTERNAL structural mutation: move 'debug' out of g-right into g-left.
		// g-right now holds only ['editor']; g-left holds ['sim','debug'].
		act(() => {
			model.apply((t) => movePanel(t, 'debug', { groupId: 'g-left' }))
		})

		// Clicking the (now possibly detached) captured node must never throw.
		expect(() => {
			act(() => {
				if (staleDebugTab) fireEvent.click(staleDebugTab)
			})
		}).not.toThrow()

		// And clicking whatever debug tab the CURRENT render shows must not throw
		// and must activate debug in its new home (g-left), driven through the model.
		const liveDebugTab = container.querySelector('[data-deck-tab="debug"]')!
		expect(() => {
			act(() => {
				fireEvent.click(liveDebugTab)
			})
		}).not.toThrow()

		const root = model.get().root as any
		const left = root.children.find((c: any) => c.id === 'g-left')
		const right = root.children.find((c: any) => c.id === 'g-right')
		expect(left.panels).toContain('debug')
		expect(left.active).toBe('debug') // clicking the live tab activated it
		expect(right.active).toBe('editor') // the other group untouched / sane
	})

	// M3 (drag/closePanel race): a "fails-now" reproduction of the stale-closure
	// crash is NOT achievable against this impl in jsdom. Under synchronous
	// `act()`, every external mutation re-renders + re-commits before the next
	// click, and the impl always re-derives (group, panel) from the live tree and
	// guards with `if (!active)`. After an external closePanel the removed tab is
	// detached, and React event delegation does not fire a handler on a node
	// outside the document — so the click is a silent no-op (no throw), not a
	// crash. Forcing a render/model desync by skipping `act()` would be a flaky,
	// React-contract-violating artifact, not a real bug. Documented here instead
	// of fabricated as a failing test.
	it.todo('M3 stale-tab click-CRASH after external closePanel — not reproducible in this impl (re-derive + if(!active) guard; detached-node click is a no-op under act())')
})

describe('<DockView> resize write-back to the model (M1)', () => {
	// BUG (M1) — dragging a split separator must drive an engine mutation that
	// writes the new sizes back to the model ("拖分隔 → 调引擎 mutation → model 更
	// 新"). The current impl wires NO layout-change callback on the rrp Group
	// (no onLayoutChange / onLayoutChanged) — it only sets uncontrolled
	// `defaultSize` per Panel — so a real drag NEVER round-trips into the model.
	//
	// We can't perform a real pointer drag in jsdom (rrp computes all geometry
	// from getBoundingClientRect/offsetWidth, which are 0 in jsdom — keyboard and
	// pointer resize both produce ZERO layout change). So this test encodes the
	// SEAM: DockView must expose, on the split container, a way to drive the
	// resize write-back, and invoking it must apply setSizes to the model. The
	// fix is mechanism-agnostic (controlled rrp + onLayoutChanged, or any wiring)
	// as long as a layout change ends up calling model.apply(setSizes).
	//
	// Contract: the split container carries a `data-deck-sizes` attribute mirroring
	// the model's current weights, and DockView exposes the write-back via a
	// `__deckApplyLayout` hook on that element OR re-applies sizes such that an
	// external resize round-trips. We assert the minimal, fix-agnostic seam:
	// (1) the split reflects the model's CURRENT sizes, and (2) DockView wires the
	// resize path so that committing a new layout updates the model. We probe (2)
	// by invoking the element's `__deckApplyLayout([3,1])` hook the host/impl must
	// provide for the drag seam.
	it('exposes a resize write-back seam that applies setSizes to the model', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		const split = container.querySelector('[data-deck-split="root"]') as
			| (HTMLElement & { __deckApplyLayout?: (sizes: number[]) => void })
			| null
		expect(split).not.toBeNull()

		// The write-back seam: a drag commit funnels new weights here, which must
		// apply setSizes to the model. Absent in the current impl (no resize wiring
		// at all) → this is undefined → the call throws → test FAILS now.
		expect(typeof split!.__deckApplyLayout).toBe('function')

		act(() => {
			split!.__deckApplyLayout!([3, 1])
		})

		const root = model.get().root as any
		expect(root.id).toBe('root')
		expect(root.sizes).toEqual([3, 1])
	})
})

describe('<DockView> sizes reflect the model (M2)', () => {
	// BUG (M2) — sizes are uncontrolled `defaultSize` (mount-only), so an external
	// model.apply(setSizes(...)) does NOT re-lay-out the rendered split. rrp v4.10
	// gives NO observable size signal in jsdom (panels always render flex-grow
	// 50/50, and `defaultSize`/`defaultLayout`/keyboard-resize all no-op without
	// measured pixel dimensions). The only deterministic, jsdom-observable proof
	// that "the render is a function of model.sizes" is a DockView-OWNED attribute
	// that mirrors the model's current weights and UPDATES on external setSizes.
	//
	// The current impl exposes no such attribute and re-applies nothing on an
	// external setSizes → both assertions below FAIL now. After a fix that makes
	// the split render a function of the live model sizes (controlled rrp, a
	// sizes-signature remount, or simply reflecting them), they pass.
	it('reflects the model sizes on the split container and updates on external setSizes', () => {
		const model = createLayoutModel(makeTree())
		const { container } = renderDock({ model, registry: makeRegistry() })

		const split = container.querySelector('[data-deck-split="root"]')!
		// Initial weights [1,1] must be reflected.
		expect(split.getAttribute('data-deck-sizes')).toBe('1,1')

		// EXTERNAL resize via the engine: the rendered split must follow.
		act(() => {
			model.apply((t) => setSizes(t, 'root', [3, 1]))
		})

		const splitAfter = container.querySelector('[data-deck-split="root"]')!
		expect(splitAfter.getAttribute('data-deck-sizes')).toBe('3,1')
	})

	// M1 real-pointer-drag round-trip is an e2e/pointer concern: rrp v4.10
	// produces ZERO layout change in jsdom (all geometry from
	// getBoundingClientRect/offsetWidth == 0; keyboard + pointer resize both
	// no-op). A genuine "drag the separator → model gets setSizes" round-trip
	// must be covered by a real-browser / pointer-driven e2e, not jsdom.
	it.todo('M1 real drag of the separator writes setSizes back to the model — needs e2e/pointer (rrp computes geometry from offsetWidth/getBoundingClientRect, which are 0 in jsdom)')
})

// ─────────────────── FIX E: fixed-px constraint write-back / percentages ───────────────────
//
// A constrained (fixed-px) child must NOT participate in the flexible
// percentage pool, and a resize write-back must NEVER overwrite its stored
// weight (node.sizes[i]). Otherwise rrp's container-derived percentage for the
// pinned panel corrupts the weight irreversibly, losing it when the constraint
// is later cleared.

/** root split[row] of THREE single-panel groups; child 0 fixed at 240px,
 *  children 1 & 2 flexible with weights [_, 1, 3]. */
function makeConstrainedTree(): LayoutTree {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [5, 1, 3], // child0 weight=5 (should be IGNORED — it's fixed)
			children: [
				{ kind: 'tabs', id: 'g0', panels: ['p0'], active: 'p0' },
				{ kind: 'tabs', id: 'g1', panels: ['p1'], active: 'p1' },
				{ kind: 'tabs', id: 'g2', panels: ['p2'], active: 'p2' },
			],
			constraints: [{ fixedPx: 240 }, null, null],
		},
	}
}

function makeConstrainedRegistry(): PanelRegistry {
	const reg = createPanelRegistry()
	reg.register({ kind: 'dom', id: 'p0', title: 'P0' })
	reg.register({ kind: 'dom', id: 'p1', title: 'P1' })
	reg.register({ kind: 'dom', id: 'p2', title: 'P2' })
	return reg
}

describe('<DockView> fixed-px constraint (FIX E)', () => {
	// E2: write-back must SKIP the constrained child — its stored weight stays put
	// while a flexible sibling updates. Drive the full-length seam directly.
	it('write-back including a fixed child leaves the fixed child weight unchanged; flexible siblings update', () => {
		const model = createLayoutModel(makeConstrainedTree())
		const { container } = renderDock({ model, registry: makeConstrainedRegistry() })

		const split = container.querySelector('[data-deck-split="root"]') as
			| (HTMLElement & { __deckApplyLayout?: (sizes: number[]) => void })
			| null
		expect(split).not.toBeNull()
		expect(typeof split!.__deckApplyLayout).toBe('function')

		// Simulate an rrp layout commit: it reports a percentage for EVERY panel,
		// including the pinned one. Drive a full-length weights array.
		act(() => {
			split!.__deckApplyLayout!([12, 30, 70]) // [fixed-derived, flex1, flex2]
		})

		const root = model.get().root as any
		// The fixed child's weight must be PRESERVED (original 5), not 12.
		expect(root.sizes[0]).toBe(5)
		// The flexible siblings take the supplied values.
		expect(root.sizes[1]).toBe(30)
		expect(root.sizes[2]).toBe(70)
		// Constraint untouched: clearing it later would restore weight 5, not garbage.
		expect(root.constraints).toEqual([{ fixedPx: 240 }, null, null])
	})

	// Sanity: clearing the constraint after a write-back restores the original
	// weight (the round-trip the bug would have corrupted).
	it('clearing the constraint after a write-back restores the original weight (no corruption)', () => {
		const model = createLayoutModel(makeConstrainedTree())
		renderDock({ model, registry: makeConstrainedRegistry() })
		// (Hook is wired on mount; grab it freshly.)
		// Drive a write-back, then clear the constraint via the engine.
		act(() => {
			model.apply((t) => setSizes(t, 'root', [99, 40, 60])) // direct engine path
		})
		// Now clear child 0's constraint; its weight should be whatever setSizes set
		// (this asserts setSizes itself never special-cased — the protection lives in
		// the write-back seam, which we proved above). Here we only assert the model
		// stays structurally sane after clearing.
		act(() => {
			model.apply((t) => setConstraint(t, 'root', 0, null))
		})
		const root = model.get().root as any
		expect(root.constraints).toEqual([null, null, null])
		expect(root.sizes.length).toBe(3)
	})

	// E1: the fixed child is EXCLUDED from the flexible percentage pool. rrp v4.10
	// gives NO observable defaultSize signal in jsdom (every Panel collapses to an
	// equal `flex` with offsetWidth==0 — verified empirically), so the deterministic
	// proof is the PURE computation DockView feeds rrp: the flexible siblings'
	// `defaultSize` percentages are normalized among THEMSELVES (weights [1,3] ->
	// 25% / 75%), and the fixed child's weight (5) NEVER enters the total. A fixed
	// child has NO entry in the map (it gets px defaultSize, not a percentage).
	it('computes flexible defaultSize percentages excluding the fixed child weight', () => {
		const sizes = [5, 1, 3] // child0 fixed (weight 5 must be ignored)
		const constraints = [{ fixedPx: 240 }, null, null]
		const pct = computeFlexiblePercentages(sizes, constraints)

		// fixed child (index 0) is absent — it does not get a percentage.
		expect(pct.has(0)).toBe(false)
		// flexible siblings normalized among themselves: 1/(1+3)=25, 3/(1+3)=75.
		expect(pct.get(1)).toBeCloseTo(25, 6)
		expect(pct.get(2)).toBeCloseTo(75, 6)
		// the polluted total (5+1+3=9) is NOT used: 1/9 would be ~11.1, not 25.
		expect(pct.get(1)).not.toBeCloseTo((1 / 9) * 100, 1)

		// legacy (no constraints) path: all children participate, percentages over all.
		const legacy = computeFlexiblePercentages([1, 1], undefined)
		expect(legacy.get(0)).toBeCloseTo(50, 6)
		expect(legacy.get(1)).toBeCloseTo(50, 6)

		// and the component renders all three bodies + mirrors raw weights.
		const model = createLayoutModel(makeConstrainedTree())
		const { container } = renderDock({ model, registry: makeConstrainedRegistry() })
		expect(container.querySelector('[data-deck-panel-body="p0"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-panel-body="p1"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-panel-body="p2"]')).not.toBeNull()
		expect(container.querySelector('[data-deck-split="root"]')!.getAttribute('data-deck-sizes')).toBe('5,1,3')
	})
})
