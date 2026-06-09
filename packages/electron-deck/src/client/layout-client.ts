import { createPlacementAnchor } from '@dimina-kit/view-anchor'
import type { Placement } from '@dimina-kit/view-anchor'

/** One main→renderer slot grant: a native view (`viewId`) wants to follow the
 *  DOM slot `slotId`; `slotToken` is the capability the renderer threads back on
 *  every `place` so main can match a placement to the granted slot. */
export interface SlotGrant {
	viewId: string
	slotId: string
	slotToken: string
}

/** The renderer-side transport for the slot-token handshake. `onSlotGrant`
 *  registers the grant listener (returns an unsubscribe); `subscribe` asks main
 *  to (re)play buffered grants AFTER the listener is attached; `sendPlace`
 *  forwards a measured placement carrying its slot's token. */
export interface LayoutBridge {
	onSlotGrant(cb: (grant: SlotGrant) => void): () => void
	sendPlace(msg: { slotToken: string; placement: Placement }): void
	subscribe(): void
}

export interface LayoutClientDeps {
	bridge: LayoutBridge
	/** Resolve a grant's `slotId` to its DOM element. Default:
	 *  `document.querySelector(slotId)`. Returns `null` when the slot is not
	 *  mounted (graceful no-op). */
	resolveSlot?(slotId: string): HTMLElement | null
	/** Anchor factory. Default: view-anchor's `createPlacementAnchor`. Injected
	 *  in tests to capture `(target, opts)` without real RO/IO/RAF. */
	createAnchor?: (
		target: HTMLElement,
		opts: {
			visible: boolean
			publish: (p: Placement) => void
			followScroll?: boolean
			followGeometry?: boolean
			guardDisplayNone?: boolean
		},
	) => { dispose(): void }
}

/**
 * Renderer half of the A5-2 slot-token handshake (§A5-2.1). Subscribes to main's
 * `slot-grant` pushes FIRST (so a grant replayed synchronously by `subscribe()`
 * cannot be missed), then on each grant anchors the granted DOM slot with this
 * session's hardening opts (followScroll / followGeometry / guardDisplayNone)
 * and threads each measured `Placement` back to main as a `place` carrying that
 * grant's `slotToken`.
 */
export function createDeckLayoutClient(deps: LayoutClientDeps): {
	dispose(): void
} {
	const resolveSlot =
		deps.resolveSlot ??
		((id: string): HTMLElement | null => document.querySelector(id))
	const createAnchor = deps.createAnchor ?? createPlacementAnchor

	const anchors: Array<{ dispose(): void }> = []
	let disposed = false

	// Register the grant listener BEFORE requesting replay (handshake §A5-2.1):
	// a grant the main side replays synchronously inside `subscribe()` must find
	// the listener already attached.
	const unsub = deps.bridge.onSlotGrant((grant) => {
		if (disposed) return
		const el = resolveSlot(grant.slotId)
		if (!el) return // slot not mounted → graceful no-op, no throw
		const anchor = createAnchor(el, {
			visible: true,
			followScroll: true,
			followGeometry: true,
			guardDisplayNone: true,
			// Capture THIS grant's slotToken in the closure so each anchor publishes
			// to its own token (no cross-talk between slots).
			publish: (placement) => {
				deps.bridge.sendPlace({ slotToken: grant.slotToken, placement })
			},
		})
		anchors.push(anchor)
	})

	// Request replay AFTER the listener is attached.
	deps.bridge.subscribe()

	return {
		dispose(): void {
			if (disposed) return
			disposed = true
			unsub()
			for (const a of anchors) a.dispose()
		},
	}
}
