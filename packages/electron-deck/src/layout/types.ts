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
 * Per-child fixed-pixel size lock. `fixedPx` must be a finite number > 0
 * (validation lives in `serialize.ts`, not the type). A child carrying a
 * `SizeConstraint` is rendered at that exact pixel width/height instead of
 * being weight-sized.
 */
export interface SizeConstraint {
	readonly fixedPx: number
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

export interface DomPanelDescriptor {
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

export interface NativePanelDescriptor {
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
