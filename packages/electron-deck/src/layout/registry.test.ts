import { describe, expect, it } from 'vitest'
import type {
	DomPanelDescriptor,
	NativePanelDescriptor,
	// FAILING: not yet exported — this import is the honest contract failure point.
	PanelCapabilities,
} from './types.js'
import { createPanelRegistry } from './index.js'

const dom = (id: string, title?: string): DomPanelDescriptor => ({ kind: 'dom', id, title })
const native = (id: string, refId: string): NativePanelDescriptor => ({
	kind: 'native',
	id,
	nativeRef: { id: refId },
})

describe('createPanelRegistry', () => {
	it('register then get returns the same descriptor', () => {
		const r = createPanelRegistry()
		const d = dom('a', 'Panel A')
		r.register(d)
		expect(r.get('a')).toEqual(d)
	})

	it('get returns undefined for unknown id', () => {
		const r = createPanelRegistry()
		expect(r.get('nope')).toBeUndefined()
	})

	it('list returns all registered descriptors', () => {
		const r = createPanelRegistry()
		r.register(dom('a'))
		r.register(native('b', 'ref-b'))
		const ids = r.list().map(p => p.id).sort()
		expect(ids).toEqual(['a', 'b'])
	})

	it('dispose() removes the descriptor (get -> undefined, drops from list)', () => {
		const r = createPanelRegistry()
		const handle = r.register(dom('a'))
		expect(r.get('a')).toBeDefined()
		handle.dispose()
		expect(r.get('a')).toBeUndefined()
		expect(r.list().map(p => p.id)).not.toContain('a')
	})

	it('preserves native opaque handle ref through register/get', () => {
		const r = createPanelRegistry()
		r.register(native('n', 'handle-123'))
		const got = r.get('n')
		expect(got?.kind).toBe('native')
		expect((got as NativePanelDescriptor).nativeRef).toEqual({ id: 'handle-123' })
	})
})

// ───────────────────────── PanelCapabilities ─────────────────────────
// FAILING TDD spec for the NOT-YET-ADDED `PanelCapabilities` contract.
//
// Contract (the implementer must build EXACTLY this):
//   export interface PanelCapabilities {
//     readonly draggable?: boolean              // default (undefined) === true
//     readonly dropPolicy?: 'free' | 'reorder-only' // default (undefined) === 'free'
//   }
// Both DomPanelDescriptor AND NativePanelDescriptor EXTEND PanelCapabilities, so
// the capability fields are valid on either descriptor and ROUND-TRIP verbatim
// through register → get → list.
//
// Honest failure points right now:
//   - TYPE: `PanelCapabilities` is not exported from `./types.js`; descriptors do
//     not carry `draggable` / `dropPolicy`, so `register({ ..., draggable:false })`
//     is an excess-property type error (the `check-types` gate goes red).
//   - RUNTIME: even if a literal slips through, the descriptors are NOT typed to
//     carry the fields, so the contract is unmet until the type is added.
describe('PanelCapabilities (drag/drop policy on descriptors)', () => {
	// BUG: descriptors can't express "this panel is not draggable", so a host can
	// never lock a panel in place — every tab is draggable, always.
	it('a dom descriptor round-trips draggable:false through register → get', () => {
		const r = createPanelRegistry()
		const d: DomPanelDescriptor & PanelCapabilities = {
			kind: 'dom',
			id: 'locked',
			title: 'Locked',
			draggable: false,
		}
		r.register(d)
		const got = r.get('locked') as DomPanelDescriptor & PanelCapabilities
		expect(got.draggable).toBe(false)
	})

	// BUG: descriptors can't express "this panel may only reorder, not leave its
	// group", so there is no way to pin a panel to its group while still letting it
	// reorder among its siblings.
	it('a dom descriptor round-trips dropPolicy:"reorder-only" through register → get', () => {
		const r = createPanelRegistry()
		const d: DomPanelDescriptor & PanelCapabilities = {
			kind: 'dom',
			id: 'pinned',
			title: 'Pinned',
			dropPolicy: 'reorder-only',
		}
		r.register(d)
		const got = r.get('pinned') as DomPanelDescriptor & PanelCapabilities
		expect(got.dropPolicy).toBe('reorder-only')
	})

	// The capability fields also apply to NATIVE descriptors (both extend
	// PanelCapabilities) and survive a list() round-trip.
	it('a native descriptor carries capabilities and survives list()', () => {
		const r = createPanelRegistry()
		const d: NativePanelDescriptor & PanelCapabilities = {
			kind: 'native',
			id: 'nat',
			nativeRef: { id: 'ref-nat' },
			draggable: false,
			dropPolicy: 'reorder-only',
		}
		r.register(d)
		const listed = r.list().find(p => p.id === 'nat') as NativePanelDescriptor & PanelCapabilities
		expect(listed.draggable).toBe(false)
		expect(listed.dropPolicy).toBe('reorder-only')
	})

	// DEFAULT-PERMISSIVE: omitting the fields leaves them undefined; the CONTRACT
	// reads undefined as draggable=true / dropPolicy='free'. We pin that a plain
	// descriptor reports neither field as a hard false/'reorder-only' value (the
	// consumer applies the permissive default).
	it('a descriptor without capability fields leaves them undefined (permissive default)', () => {
		const r = createPanelRegistry()
		r.register(dom('plain', 'Plain'))
		const got = r.get('plain') as DomPanelDescriptor & PanelCapabilities
		expect(got.draggable).toBeUndefined()
		expect(got.dropPolicy).toBeUndefined()
	})

	// The type member itself must be EXPORTED (a host imports it to type a
	// descriptor map). A pure type can't be asserted at runtime, so we pin its
	// shape at compile time: a value typed as PanelCapabilities accepts the
	// optional fields and nothing else. This line stops compiling if the type is
	// missing or renamed.
	it('PanelCapabilities is an exported type with all optional fields', () => {
		const cap: PanelCapabilities = { draggable: true, dropPolicy: 'free', closable: false }
		const empty: PanelCapabilities = {}
		expect(cap.draggable).toBe(true)
		expect(cap.dropPolicy).toBe('free')
		expect(cap.closable).toBe(false)
		expect(empty.draggable).toBeUndefined()
		expect(empty.closable).toBeUndefined()
	})
})
