/**
 * Layout-as-data engine — core types.
 *
 * PURE TS. This file (and the whole `src/layout/` directory) MUST NOT import
 * `electron`, `react`, or `react-dom`. The boundary is a tested invariant
 * (see `boundary.test.ts`). Native panels reference an electron-free opaque
 * handle (`NativeHandleRef`) instead of an electron `ViewHandle`.
 */

export type Orientation = 'row' | 'column'

/**
 * Per-child pixel size constraint. EXACTLY ONE of the two keys is set; the value
 * is a finite number > 0 (validation lives in `serialize.ts`, not the type):
 *
 *  - `fixedPx` — LOCKED to exactly N px (min === max). Excluded from the
 *    flexible weight pool: it never resizes, weight changes don't touch it.
 *  - `minPx` — px-sized with a minimum floor of N px. Like `fixedPx`, it is
 *    excluded from the flexible weight pool (it never receives a share of the
 *    weight-driven remainder) — but unlike `fixedPx` it has no upper bound, so
 *    the user can still drag it wider than the floor. Use for a panel that must
 *    keep a minimum size while still being draggable (e.g. a simulator column
 *    floored at the device width).
 *
 * KEY SEMANTIC: "is this child px-sized?" === "is the constraint non-null?"
 * Both `fixedPx` and `minPx` are px-sized and excluded from the weight pool;
 * only a `null` (or absent) constraint is weight-sized.
 */
export interface SizeConstraint {
	readonly fixedPx?: number
	readonly minPx?: number
}

export interface SplitNode {
	readonly kind: 'split'
	readonly id: string
	readonly orientation: Orientation
	readonly children: readonly LayoutNode[]
	/** Same length as `children`. One weight per child. */
	readonly sizes: readonly number[]
	/**
	 * OPTIONAL. When present, same length as `children`. `constraints[i] === null`
	 * → child i is weight-sized (uses `sizes[i]`); `{ fixedPx: N }` → locked to N
	 * px. ABSENT (undefined) = legacy weight-only behavior; never injected by the
	 * engine for trees that don't use it.
	 */
	readonly constraints?: readonly (SizeConstraint | null)[]
}

export interface TabGroupNode {
	readonly kind: 'tabs'
	readonly id: string
	/** panelIds, order = tab order. */
	readonly panels: readonly string[]
	/** Must be ∈ panels. */
	readonly active: string
}

export type LayoutNode = SplitNode | TabGroupNode

export interface LayoutTree {
	readonly version: 1
	readonly root: LayoutNode
}

// ───────────────────────── panel registry ─────────────────────────

/**
 * Per-panel drag/drop capability policy. All fields are OPTIONAL and
 * DEFAULT-PERMISSIVE, so existing registrations keep today's behavior (a fully
 * draggable, closable panel that may move/split freely). The fields are orthogonal:
 * `draggable` governs whether the panel is a drag SOURCE / drop ANCHOR at all;
 * `dropPolicy` governs where a draggable panel may LAND; `closable` governs
 * whether DockView exposes the panel's close affordance.
 */
export interface PanelCapabilities {
	/**
	 * When `false`: the panel's tab cannot be picked up (its tab is not
	 * `draggable`) AND it is not a valid drop ANCHOR — no other panel may
	 * join/split against the group while this panel is that group's active tab.
	 * `undefined` is treated as `true`.
	 */
	readonly draggable?: boolean
	/**
	 * Drop/move policy for THIS panel when it is the one being dragged:
	 *  - `'free'` (default): may move to any group or edge-split anywhere.
	 *  - `'reorder-only'`: may ONLY reorder within its CURRENT tab group — it
	 *    never leaves the group and never edge-splits.
	 * `undefined` is treated as `'free'`.
	 */
	readonly dropPolicy?: 'free' | 'reorder-only'
	/**
	 * When `false`, DockView does not render a close affordance for this panel.
	 * `undefined` is treated as `true`.
	 */
	readonly closable?: boolean
	/**
	 * When `true`, this panel contributes NO tab to the group's tab strip. A
	 * group whose every panel hides its tab renders no tab strip at all (its body
	 * fills the whole region). Use for structural/chrome-owning panels that carry
	 * their own header (e.g. a simulator panel that draws its own device picker),
	 * where the engine tab would be redundant. `undefined` is treated as `false`.
	 */
	readonly hideTab?: boolean
}

export interface DomPanelDescriptor extends PanelCapabilities {
	readonly kind: 'dom'
	readonly id: string
	readonly title?: string
}

/**
 * Electron-free opaque reference to a native view handle. The layout core
 * never touches electron; the host maps this `id` back to a real handle.
 */
export interface NativeHandleRef {
	readonly id: string
}

export interface NativePanelDescriptor extends PanelCapabilities {
	readonly kind: 'native'
	readonly id: string
	readonly title?: string
	readonly nativeRef: NativeHandleRef
}

export type PanelDescriptor = DomPanelDescriptor | NativePanelDescriptor

export interface Disposable {
	dispose(): void
}

export interface PanelRegistry {
	register(p: PanelDescriptor): Disposable
	get(id: string): PanelDescriptor | undefined
	list(): readonly PanelDescriptor[]
}

// ───────────────────────── observable model ─────────────────────────

export interface LayoutSnapshot {
	readonly tree: LayoutTree
	readonly revision: number
}

export interface LayoutModel {
	get(): LayoutTree
	apply(mut: (t: LayoutTree) => LayoutTree): void
	subscribe(fn: (snap: LayoutSnapshot) => void): () => void
}
