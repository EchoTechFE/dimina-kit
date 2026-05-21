/**
 * Generic DOM-event → service-callback bridge.
 *
 * Container-side media APIs (audio, and in future recorder / video) need to
 * forward DOM media events on an `HTMLMediaElement` out to the mini-program
 * service layer. This helper centralises the "bind a set of DOM events, build
 * a typed payload, invoke `fire`, return a disposer" pattern so each media API
 * does not re-implement it.
 */

/**
 * Builds the payload handed to `fire` for a given mini-program event name.
 * Receives the mini-program event name (already mapped from the DOM name) and
 * the DOM event, and returns the object delivered to the service callback.
 */
export type PayloadBuilder<P> = (event: string, domEvent: Event) => P

/** Disposer returned by {@link bindDomEvents}; unbinds every listener. */
export type EventBridgeDisposer = () => void

/**
 * Bind a batch of DOM events on `target`.
 *
 * @param target   The EventTarget (e.g. an `HTMLAudioElement`) to listen on.
 * @param eventMap Map of DOM event name → mini-program event name.
 * @param fire     The service callback; called once per DOM event with the
 *                 payload produced by `buildPayload`.
 * @param buildPayload Produces the typed payload for `fire`.
 * @returns A disposer that removes every listener registered by this call.
 */
export function bindDomEvents<P>(
	target: EventTarget,
	eventMap: Record<string, string>,
	fire: (payload: P) => void,
	buildPayload: PayloadBuilder<P>,
): EventBridgeDisposer {
	const registered: Array<[string, EventListener]> = []

	for (const [domName, miniName] of Object.entries(eventMap)) {
		const listener: EventListener = (domEvent) => {
			fire(buildPayload(miniName, domEvent))
		}
		target.addEventListener(domName, listener)
		registered.push([domName, listener])
	}

	return () => {
		for (const [domName, listener] of registered) {
			target.removeEventListener(domName, listener)
		}
		registered.length = 0
	}
}
