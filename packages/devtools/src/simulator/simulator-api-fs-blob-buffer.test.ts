/**
 * Contract: the `_tmp` Blob->bytes bridge (`fsSaveFile` materializing a
 * `difile://_tmp/*` source, `fsReadFile` of a `difile://_tmp/*` path) must
 * source `Buffer` from the preload-published `__diminaNodeBindings` bag, not
 * from a global. The simulator top document runs with nodeIntegration off
 * and its vite bundle stubs `node:*` imports — there is NO global `Buffer`
 * there, and the bindings bag is the only real-module source (see
 * `../shared/node-bindings.ts`).
 *
 * Deleting the global `Buffer` inside vitest is NOT a faithful simulation:
 * vite-node's own module runner reads the global in its source-map stack
 * mapper (`Error.prepareStackTrace` -> `getModuleSourceMapById` ->
 * `Buffer.from` in vite's module-runner), so removing it breaks the test
 * FRAMEWORK process-wide, independent of the code under test. These tests
 * therefore keep the global intact and instead publish an INSTRUMENTED
 * bindings bag whose `Buffer.from` counts its calls: the implementation
 * resolves bindings-first (global is only a fallback), so a positive count
 * proves the browser-world source is the one actually consulted.
 *
 * `simulator-api-fs.ts` snapshots the bag once at module-load time, so each
 * test resets the module registry and dynamically imports both
 * `./simulator-api-fs` and `./temp-files` inside the SAME reset epoch (the
 * `_tmp` Blob registered through the freshly-imported `createTempFilePath`
 * must be visible to the freshly-imported handlers' own `./temp-files`
 * import).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import * as nodeCrypto from 'node:crypto'
import * as nodeBuffer from 'node:buffer'
import { NODE_BINDINGS_GLOBAL } from '../shared/node-bindings.js'
import type { MiniAppContext } from './types'

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) =>
			typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined,
		),
	} as unknown as MiniAppContext
}

interface InvokeResult { success?: unknown; fail?: unknown; complete: boolean }

function invoke(
	handler: unknown,
	args: Record<string, unknown>,
): Promise<InvokeResult> {
	return new Promise((resolve) => {
		let resolved = false
		let successResult: unknown
		let failResult: unknown
		let didComplete = false
		const settle = () => {
			if (resolved) return
			resolved = true
			resolve({ success: successResult, fail: failResult, complete: didComplete })
		}
		const success = vi.fn((r: unknown) => { successResult = r })
		const fail = vi.fn((r: unknown) => { failResult = r })
		const complete = vi.fn(() => { didComplete = true; settle() })
		// Fail-safe: settle after a short tick so a hung handler reports what DID fire.
		setTimeout(settle, 500)
		;(handler as (this: MiniAppContext, opts: Record<string, unknown>) => void)
			.call(makeContext(), { ...args, success, fail, complete })
	})
}

function getErrMsg(payload: unknown): string {
	if (payload && typeof payload === 'object' && 'errMsg' in payload) {
		return String((payload as { errMsg: unknown }).errMsg)
	}
	return ''
}

let sandboxHome: string
let bindingFromCalls: number

/**
 * Publishes a bindings bag whose `Buffer.from` counts every call, so a test
 * can assert the implementation consulted the BINDINGS Buffer (the only
 * source that exists in the browser world) rather than the global fallback.
 */
function installInstrumentedBindings(): void {
	const instrumentedBuffer = new Proxy(nodeBuffer.Buffer, {
		get(target, prop, receiver) {
			if (prop === 'from') {
				return (...args: Parameters<typeof Buffer.from>) => {
					bindingFromCalls += 1
					return target.from(...args)
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	const bag = Object.freeze({
		fs: nodeFs,
		os: nodeOs,
		path: nodePath,
		crypto: nodeCrypto,
		buffer: { ...nodeBuffer, Buffer: instrumentedBuffer },
	})
	Object.defineProperty(globalThis, NODE_BINDINGS_GLOBAL, {
		value: bag,
		writable: false,
		configurable: true,
		enumerable: true,
	})
}

/** Clears the bindings bag; the property is published `configurable: true`. */
function resetBindings(): void {
	try {
		Object.defineProperty(globalThis, NODE_BINDINGS_GLOBAL, {
			value: undefined,
			writable: true,
			configurable: true,
			enumerable: true,
		})
	} catch {
		// Non-configurable: leave whatever a previous install locked in place.
	}
}

beforeEach(() => {
	sandboxHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-fsm-blob-buffer-test-'))
	process.env.DIMINA_HOME = sandboxHome
	bindingFromCalls = 0
	resetBindings()
	// Force `./simulator-api-fs` (and its `./temp-files` import) to re-evaluate
	// against the bindings bag installed by each test, rather than reusing a
	// module instance cached with a different bindings snapshot.
	vi.resetModules()
})

afterEach(() => {
	resetBindings()
	delete process.env.DIMINA_HOME
	if (sandboxHome && nodeFs.existsSync(sandboxHome)) {
		nodeFs.rmSync(sandboxHome, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
})

describe('_tmp Blob -> bytes sources Buffer from the published node bindings', () => {
	it('fsSaveFile(tempFilePath: difile://_tmp/...) materializes the Blob bytes exactly onto disk via the bindings Buffer', async () => {
		installInstrumentedBindings()

		const tempFiles = await import('./temp-files')
		const fsApi = await import('./simulator-api-fs')

		const bytes = [1, 2, 3, 250]
		const blob = new Blob([new Uint8Array(bytes)])
		const tempFilePath = tempFiles.createTempFilePath(blob)
		expect(tempFilePath).toMatch(/^difile:\/\/_tmp\//)

		const r = await invoke(fsApi.fsSaveFile, { tempFilePath })
		expect(r.fail, `fsSaveFile failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const savedFilePath = (r.success as { savedFilePath?: string } | undefined)?.savedFilePath
		expect(savedFilePath, 'fsSaveFile should report a difile://_store/ vpath').toMatch(/^difile:\/\/_store\//)

		const storeRelative = savedFilePath!.slice('difile://_store/'.length)
		const onDisk = nodeFs.readFileSync(nodePath.join(sandboxHome, 'files', '_store', storeRelative))
		expect(Array.from(onDisk)).toEqual(bytes)
		expect(
			bindingFromCalls,
			'the Blob->bytes bridge must consult the bindings Buffer (the only source in the browser world), not a global',
		).toBeGreaterThan(0)
	})

	it('fsReadFile(filePath: difile://_tmp/..., no encoding) answers the exact Blob bytes via the bindings Buffer', async () => {
		installInstrumentedBindings()

		const tempFiles = await import('./temp-files')
		const fsApi = await import('./simulator-api-fs')

		const bytes = [9, 8, 7, 6, 5]
		const blob = new Blob([new Uint8Array(bytes)])
		const tempFilePath = tempFiles.createTempFilePath(blob)

		const r = await invoke(fsApi.fsReadFile, { filePath: tempFilePath })
		expect(r.fail, `fsReadFile failed: ${JSON.stringify(r.fail)}`).toBeUndefined()
		const data = (r.success as { data?: unknown } | undefined)?.data
		expect(data, 'fsReadFile must return the bytes, not undefined').toBeDefined()
		expect(Array.from(data as ArrayLike<number>)).toEqual(bytes)
		expect(bindingFromCalls).toBeGreaterThan(0)
	})

	it('an unregistered _tmp id still fails with an ENOENT-shaped message', async () => {
		installInstrumentedBindings()

		const fsApi = await import('./simulator-api-fs')
		const r = await invoke(fsApi.fsReadFile, { filePath: 'difile://_tmp/00000000-0000-0000-0000-000000000000' })
		expect(r.success).toBeUndefined()
		expect(r.fail).toBeDefined()
		expect(getErrMsg(r.fail)).toMatch(/^fsReadFile:fail /)
		expect(getErrMsg(r.fail)).not.toMatch(/Buffer is not defined/)
	})
})
