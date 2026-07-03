import { createPlacementAnchor } from '@dimina-kit/view-anchor'
import type { Placement } from '@dimina-kit/view-anchor'
import { createPlacementPublisher } from './placement-publisher.js'
import type { PlacementSnapshot } from '../layout/index.js'

/** Per-view host extra threaded on every DesiredView: the slot's capability
 *  token. Main derives the view's identity + z-order from this token (never from
 *  the renderer-reported viewId), so a valid token can't be spliced onto a forged
 *  viewId. */
export interface SlotExtra {
	slotToken: string
}

/** One main→renderer slot grant: a native view (`viewId`) wants to follow the
 *  DOM slot `slotId`; `slotToken` is the capability the renderer threads back
 *  (as a per-view extra) so main can match a placement to the granted slot.
 *  `generation` is a main-assigned, strictly-monotonic-per-wc renderer-lifetime
 *  id: it is stamped onto every published snapshot so a reload (new grants at a
 *  higher generation) resets main's reconciler regardless of IPC ordering. */
export interface SlotGrant {
	viewId: string
	slotId: string
	slotToken: string
	generation: number
}

/** The renderer-side transport for the slot-token handshake. `onSlotGrant`
 *  registers the grant listener (returns an unsubscribe); `subscribe` asks main
 *  to (re)play buffered grants AFTER the listener is attached; `sendSnapshot`
 *  forwards the whole window-level desired-placement table (one coalesced frame),
 *  each view carrying its slot's token as an extra. */
export interface LayoutBridge {
	onSlotGrant(cb: (grant: SlotGrant) => void): () => void
	sendSnapshot(snapshot: PlacementSnapshot<SlotExtra>): void
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
	/** Frame scheduler for the internal placement publisher. Default:
	 *  requestAnimationFrame / cancelAnimationFrame. Injected in tests to drive
	 *  coalesced publishes deterministically. */
	requestFrame?: (cb: () => void) => number
	cancelFrame?: (id: number) => void
}

/**
 * Renderer half of the slot-token handshake. Subscribes to main's `slot-grant`
 * pushes FIRST (so a grant replayed synchronously by `subscribe()` cannot be
 * missed), then on each grant anchors the granted DOM slot with this session's
 * hardening opts (followScroll / followGeometry / guardDisplayNone). Each anchor's
 * measured `Placement` is written into a CENTRAL placement publisher keyed by
 * `viewId` — NOT sent per-view. The publisher coalesces every anchor's writes into
 * ONE window-level snapshot per animation frame, so a transient relayout that
 * momentarily measures 0×0 is overwritten before it is ever published. This is the
 * producer half of the level-triggered reconcile design (see
 * ../layout/placement-reconcile.ts); a per-view edge stream cannot self-correct a
 * lost or spurious frame, which is what caused a stuck detached (white-screen)
 * view.
 */
export function createDeckLayoutClient(deps: LayoutClientDeps): {
	dispose(): void
} {
	const resolveSlot =
		deps.resolveSlot ??
		((id: string): HTMLElement | null => document.querySelector(id))
	const createAnchor = deps.createAnchor ?? createPlacementAnchor

	// Max generation seen across all grants. Main assigns strictly-monotonic
	// generations, so taking the max means a reload's higher-generation grants
	// bump every subsequent snapshot's generation → main's reconciler resets.
	let maxGeneration = 0

	// Central publisher: every anchor writes its view's desired placement here; the
	// publisher reads the whole table once per frame and publishes one snapshot.
	const publisher = createPlacementPublisher<SlotExtra>({
		generation: () => maxGeneration,
		publish: snapshot => deps.bridge.sendSnapshot(snapshot),
		requestFrame: deps.requestFrame,
		cancelFrame: deps.cancelFrame,
	})

	// One live anchor per `viewId`. Main intentionally re-delivers a grant on
	// per-wc replay, so we dedup: a same-token replay is a no-op (keep the live
	// anchor); a new token for an existing `viewId` replaces it (dispose old,
	// create new). The map holds only CURRENTLY-LIVE anchors — a replaced anchor
	// is disposed at replacement time and removed, so `dispose()` never
	// double-disposes it.
	const byViewId = new Map<string, { token: string; anchor: { dispose(): void } }>()
	let disposed = false

	// Register the grant listener BEFORE requesting replay (handshake):
	// a grant the main side replays synchronously inside `subscribe()` must find
	// the listener already attached.
	const unsub = deps.bridge.onSlotGrant((grant) => {
		if (disposed) return
		if (grant.generation > maxGeneration) maxGeneration = grant.generation
		const existing = byViewId.get(grant.viewId)
		// Same viewId+token re-delivered (per-wc replay) → pure no-op: keep the
		// live anchor, do not create a second, do not dispose the first.
		if (existing && existing.token === grant.slotToken) return
		// A new token for this viewId → REVOKE the stale anchor FIRST: dispose it,
		// drop it from the publisher table, and remove it from the map BEFORE
		// resolving the new slot, so a stale anchor can never keep contributing a
		// revoked token even when the new slot isn't mounted yet.
		if (existing) {
			// try/finally: the map delete + publisher.remove MUST run even if the old
			// anchor's dispose throws — otherwise the disposed-but-still-mapped anchor
			// keeps its snapshot entry AND a later client.dispose() would dispose it a
			// second time.
			try {
				existing.anchor.dispose()
			}
			finally {
				byViewId.delete(grant.viewId)
				publisher.remove(grant.viewId)
			}
		}
		const el = resolveSlot(grant.slotId)
		if (!el) return // new slot not mounted → graceful no-op; old anchor already revoked
		const token = grant.slotToken
		const anchor = createAnchor(el, {
			visible: true,
			followScroll: true,
			followGeometry: true,
			guardDisplayNone: true,
			// Capture THIS grant's viewId + slotToken so the measured placement lands
			// in the central publisher under the right key with its own token (no
			// cross-talk between slots). layer is 0: z-order is host-controlled
			// (compositor zone), not renderer-driven.
			publish: (placement) => {
				publisher.set({ viewId: grant.viewId, placement, layer: 0, extra: { slotToken: token } })
			},
		})
		byViewId.set(grant.viewId, { token, anchor })
	})

	// Request replay AFTER the listener is attached.
	deps.bridge.subscribe()

	return {
		dispose(): void {
			if (disposed) return
			disposed = true
			unsub()
			for (const { anchor } of byViewId.values()) anchor.dispose()
			byViewId.clear()
			// Dispose the publisher LAST so no anchor teardown races a pending frame.
			publisher.dispose()
		},
	}
}
