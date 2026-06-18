/**
 * Layout-as-data engine — public surface.
 *
 * PURE TS — no electron / react import anywhere under `src/layout/`.
 * Implementation lives in the colocated modules; this file is the single public
 * entry that re-exports every symbol.
 */

export type {
	Orientation,
	SizeConstraint,
	SplitNode,
	TabGroupNode,
	LayoutNode,
	LayoutTree,
	DomPanelDescriptor,
	NativeHandleRef,
	NativePanelDescriptor,
	PanelCapabilities,
	PanelDescriptor,
	Disposable,
	PanelRegistry,
	LayoutSnapshot,
	LayoutModel,
} from './types.js'

export { createPanelRegistry } from './registry.js'
export { serializeLayout, parseLayout, validateTree } from './serialize.js'
export { sanitizeFlexibleWeights } from './sanitize.js'
export {
	setSizes,
	setConstraint,
	setActive,
	movePanel,
	splitPanel,
	closePanel,
	extractPanel,
	insertPanel,
} from './mutations.js'
export { createLayoutModel } from './model.js'
