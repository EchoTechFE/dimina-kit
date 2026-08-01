/**
 * invokeAPI fallback wiring (main → simulator). Main forwards any invokeAPI
 * name that is not registered in its ctx.simulatorApis registry to the
 * simulator document; the simulator-resident MiniApp owns the wx.* handler
 * (it can read DOM, open file pickers, …). Each forwarded call is run via
 * `runApiAsync` (which captures the handler's success/fail callbacks) and
 * its verdict echoed back so main can fire the original service-side
 * callbacks against their service-host ids.
 */

import { SIMULATOR_EVENTS as E } from '../shared/bridge-channels'
import type { ApiCallPayload } from '../shared/bridge-channels'
import type { SimulatorMiniApp } from './simulator-mini-app'
import { runApiAsync } from './run-api-async'

/**
 * Subscribes the API_CALL session event and forwards each call into the
 * MiniApp's handler registry. Returns the unsubscribe disposer.
 */
export function attachApiCallForwarding(miniApp: SimulatorMiniApp): () => void {
	const listener = (payload: ApiCallPayload) => {
		// Handler-received ack: tell main a live handler exists BEFORE running
		// it, so the flat no-handler watchdog is disarmed for calls whose
		// verdict legitimately takes longer than the window (large FSM disk
		// writes, modals waiting on the user). Calls with no registered
		// handler skip the ack and keep the watchdog as their backstop.
		if (miniApp.apiRegistry[payload.name]) {
			miniApp.notifyApiResponse({ requestId: payload.requestId, ok: false, ack: true })
		}
		// `emit` fires once for one-shot APIs and on every subsequent success
		// for persistent (`keep: true`) subscriptions like audioListen, so each
		// container audio event reaches the service-side dispatcher.
		void runApiAsync(miniApp, payload.name, payload.params, (verdict) => {
			miniApp.notifyApiResponse({
				requestId: payload.requestId,
				ok: verdict.ok,
				result: verdict.result,
				errMsg: verdict.errMsg,
				keep: verdict.keep,
			})
		})
	}
	return miniApp.onSessionEvent(E.API_CALL, listener)
}
