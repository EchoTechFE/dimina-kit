/**
 * Contract: `downloadFile` must enforce its OWN timeout budget instead of a
 * bare `fetch(...)` with no deadline. Main's ACK watchdog
 * (`apiCallWatchdogMs` in `simulator-api-metadata.ts`) only covers the time
 * up to the invokeAPI ACK — once downloadFile has ACKed and is awaiting the
 * network response, nothing else bounds how long a stalled `fetch` hangs.
 * A caller-supplied `timeout` (or, absent that, the wx default budget —
 * `DEFAULT_REQUEST_TIMEOUT_MS` in
 * `packages/dimina-electron-runtime/src/shared/request-core.ts`, the same
 * 60000ms authority `performRequest` uses) must fail the call with a
 * "downloadFile:fail timeout" errMsg once elapsed, and a `fetch` that
 * settles AFTER that verdict must not resurrect a second one — matching the
 * first-verdict-wins contract every other async wx callback triad upholds.
 *
 * `uploadFile` already enforces its own deadline via `xhr.timeout` /
 * `xhr.ontimeout` (see `simulator-api-network.ts` lines ~170-199) and that
 * behavior is already covered by `simulator-api-upload.test.ts`'s "uploadFile
 * timeout default" and "reports xhr network and timeout failures" suites —
 * no new coverage is added here for uploadFile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { downloadFile } from './simulator-api-network'
import { revokeAllTempFilePaths } from './temp-files'

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) =>
			typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined,
		),
	} as unknown as MiniAppContext
}

function getErrMsg(payload: unknown): string {
	if (payload && typeof payload === 'object' && 'errMsg' in payload) {
		return String((payload as { errMsg: unknown }).errMsg)
	}
	return ''
}

/** A fetch stub whose promise never settles on its own — the call only resolves through downloadFile's own timeout. */
function hangingFetch(): ReturnType<typeof vi.fn> {
	return vi.fn(() => new Promise(() => {}))
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	revokeAllTempFilePaths()
	vi.restoreAllMocks()
})

describe('downloadFile enforces its own timeout budget (independent of the main-process ACK watchdog)', () => {
	it('a stalled fetch fails with "downloadFile:fail timeout..." once the caller timeout elapses, and completes exactly once', async () => {
		vi.stubGlobal('fetch', hangingFetch())
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		downloadFile.call(makeContext(), { url: 'https://example.com/x.bin', timeout: 1000, success, fail, complete })

		await vi.advanceTimersByTimeAsync(1000)

		expect(success).not.toHaveBeenCalled()
		expect(fail).toHaveBeenCalledTimes(1)
		expect(getErrMsg(fail.mock.calls[0]![0])).toMatch(/^downloadFile:fail timeout/)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('a fetch that resolves AFTER the timeout already failed must not fire a second (success) verdict or a second complete', async () => {
		let resolveFetch!: (value: unknown) => void
		vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve })))
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		downloadFile.call(makeContext(), { url: 'https://example.com/x.bin', timeout: 1000, success, fail, complete })
		await vi.advanceTimersByTimeAsync(1000)
		expect(fail).toHaveBeenCalledTimes(1)

		resolveFetch({
			ok: true,
			status: 200,
			blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
		})
		// Let the late `.then()` chain from the resolved fetch settle, if the
		// implementation is still holding a reference to it.
		await vi.advanceTimersByTimeAsync(0)
		await Promise.resolve()
		await Promise.resolve()

		expect(success, 'a late-settling fetch must not resurrect a success verdict after the timeout already failed').not.toHaveBeenCalled()
		expect(fail).toHaveBeenCalledTimes(1)
		expect(complete, 'complete must fire exactly once total, not once per verdict attempt').toHaveBeenCalledTimes(1)
	})

	it('when the caller omits timeout, the wx default budget (60000ms) applies before failing', async () => {
		vi.stubGlobal('fetch', hangingFetch())
		const fail = vi.fn()
		const complete = vi.fn()

		downloadFile.call(makeContext(), { url: 'https://example.com/x.bin', fail, complete })

		await vi.advanceTimersByTimeAsync(59_999)
		expect(fail, 'must not fail before the 60000ms default budget elapses').not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(fail).toHaveBeenCalledTimes(1)
		expect(getErrMsg(fail.mock.calls[0]![0])).toMatch(/^downloadFile:fail timeout/)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('a fetch that resolves before the timeout succeeds normally and clears its own timer (no stray later timeout-fail)', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
			ok: true,
			status: 200,
			blob: async () => new Blob([new Uint8Array([9, 9])]),
		})))
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		downloadFile.call(makeContext(), { url: 'https://example.com/x.bin', timeout: 1000, success, fail, complete })

		await vi.advanceTimersByTimeAsync(0)
		await Promise.resolve()
		await Promise.resolve()

		expect(success).toHaveBeenCalledTimes(1)
		expect(success.mock.calls[0]![0]).toMatchObject({ errMsg: 'downloadFile:ok' })
		expect(complete).toHaveBeenCalledTimes(1)

		// If the timeout timer were left running past a success verdict, this
		// advance would fire a stray second `fail` / `complete`.
		await vi.advanceTimersByTimeAsync(2000)
		expect(fail).not.toHaveBeenCalled()
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('a non-ok response with an empty statusText fails with the HTTP status code, not a blank reason', async () => {
		// Guards that a non-ok response always carries its HTTP status code in
		// the errMsg. statusText alone is unreliable — real fetch
		// implementations produce an empty reason phrase (HTTP/2 has none),
		// which would leave the caller a blank "downloadFile:fail " with no
		// way to distinguish e.g. a 503 from a 404.
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, statusText: '' })))
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		downloadFile.call(makeContext(), { url: 'https://example.com/x.bin', timeout: 1000, success, fail, complete })
		await vi.advanceTimersByTimeAsync(0)
		await Promise.resolve()
		await Promise.resolve()

		expect(success).not.toHaveBeenCalled()
		expect(fail).toHaveBeenCalledTimes(1)
		expect(getErrMsg(fail.mock.calls[0]![0])).toMatch(/^downloadFile:fail HTTP 503/)
		expect(complete).toHaveBeenCalledTimes(1)

		// The timeout timer set at call time must be cleared once the HTTP
		// failure verdict fires — advancing past the original timeout budget
		// must not resurrect a second (timeout) fail or complete.
		await vi.advanceTimersByTimeAsync(2000)
		expect(fail).toHaveBeenCalledTimes(1)
		expect(complete).toHaveBeenCalledTimes(1)
	})
})
