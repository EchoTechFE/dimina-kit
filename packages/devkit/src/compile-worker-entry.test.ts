import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * Contract for the compile worker ENTRY module.
 *
 * Compilation runs in a forked, long-lived child process instead of the
 * Electron main process. Root causes the fork avoids:
 *   - `process.chdir(projectPath)` globally mutating the host process cwd,
 *   - a global stdout/stderr write-hook capturing unrelated host logs,
 *   - compiler crashes taking down the host process,
 *   - listr2 isTTY hacks on the host's real streams.
 *
 * Required contract — `src/compile-worker-entry.ts`:
 *  - This module is the `child_process.fork()` target. When forked it wires
 *    `process.on('message', …)` / `process.send` itself (not unit-tested
 *    here — covered by the parent-side orchestration contract +
 *    integration). For unit-testability it exports the handler factory:
 *
 *    `createCompileWorkerHandler(deps): (msg: unknown) => Promise<void>`
 *      deps = {
 *        loadCompiler: () => build,   // lazy require('@dimina/compiler')
 *        chdir: (dir) => void,        // process.chdir — CHILD-process cwd
 *        send: (result) => void,      // process.send
 *      }
 *
 *  - Inbound IPC message:
 *      { cmd: 'build', projectPath, outputDir, options: { sourcemap? } }
 *    Anything else is ignored (no compiler load, no reply).
 *  - On a build command: chdir(projectPath) IN THE CHILD, then call the
 *    compiler exactly as the in-process call sites did today:
 *      build(outputDir, projectPath, true, options)
 *    and reply `send({ type: 'result', appInfo })`.
 *  - Compiler loading is LAZY (deferred to the first build command, so the
 *    fork itself stays fast) and CACHED (loaded once per worker lifetime).
 *  - `@dimina/compiler`'s build() swallows compile errors internally
 *    (console.error + resolve undefined, never rethrows). The IPC protocol
 *    normalizes that to `{ type: 'result', appInfo: null }`.
 *  - If build() DOES throw/reject (defensive — worker init failures etc.),
 *    the handler must still reply, with
 *    `{ type: 'result', appInfo: null, error: { message } }`, and the
 *    handler promise must resolve (a hung parent awaiting a reply that never
 *    comes would wedge the rebuild scheduler).
 */

type AppInfo = { appId: string; name: string; path: string }
type BuildOptions = { sourcemap?: boolean }
type BuildFn = (
	outputDir: string,
	projectPath: string,
	useAppIdDir: boolean,
	options: BuildOptions,
) => Promise<AppInfo | null | undefined>
type WorkerResult = {
	type: 'result'
	appInfo: AppInfo | null
	error?: { message: string }
}
type WorkerDeps = {
	loadCompiler: () => BuildFn
	chdir: (dir: string) => void
	send: (msg: WorkerResult) => void
}
type CreateHandler = (deps: WorkerDeps) => (msg: unknown) => Promise<void>

async function getCreateHandler(): Promise<CreateHandler> {
	const mod: unknown = await import('./compile-worker-entry.js' as string).catch(() => null)
	expect(
		mod,
		'src/compile-worker-entry must exist — it is the child_process.fork() target of the compile worker',
	).not.toBeNull()
	const fn = (mod as Record<string, unknown>).createCompileWorkerHandler
	expect(
		typeof fn,
		'compile-worker-entry must export createCompileWorkerHandler(deps) so the IPC message handling is unit-testable without forking',
	).toBe('function')
	return fn as CreateHandler
}

const FIXTURE_APP: AppInfo = {
	appId: 'fixture_app_001',
	name: 'fixture-app',
	path: '/tmp/fixture-project',
}

const BUILD_MSG = {
	cmd: 'build',
	projectPath: '/tmp/fixture-project',
	outputDir: '/tmp/fixture-out',
	options: { sourcemap: true },
}

function makeDeps(build: BuildFn): {
	deps: WorkerDeps
	buildSpy: ReturnType<typeof vi.fn>
	callOrder: string[]
} {
	const callOrder: string[] = []
	const buildSpy = vi.fn((...args: Parameters<BuildFn>) => {
		callOrder.push('build')
		return build(...args)
	})
	const deps: WorkerDeps = {
		loadCompiler: vi.fn(() => buildSpy as unknown as BuildFn),
		chdir: vi.fn((_dir: string) => {
			callOrder.push('chdir')
		}),
		send: vi.fn((_msg: WorkerResult) => {}),
	}
	return { deps, buildSpy, callOrder }
}

describe('compile-worker-entry — createCompileWorkerHandler (fork-side IPC handler)', () => {
	it('does NOT load the compiler at handler creation (the fork must stay fast)', async () => {
		const createHandler = await getCreateHandler()
		const { deps } = makeDeps(async () => FIXTURE_APP)

		createHandler(deps)

		expect(
			deps.loadCompiler,
			'loadCompiler must be deferred to the first build command — requiring @dimina/compiler at fork time defeats the fast long-lived worker',
		).not.toHaveBeenCalled()
	})

	it('ignores non-build messages: no compiler load, no reply, no throw', async () => {
		const createHandler = await getCreateHandler()
		const { deps } = makeDeps(async () => FIXTURE_APP)
		const handler = createHandler(deps)

		await handler(null)
		await handler('hello')
		await handler({ cmd: 'shutdown' })
		await handler({})

		expect(deps.loadCompiler).not.toHaveBeenCalled()
		expect(deps.send, 'unknown messages must not produce a reply').not.toHaveBeenCalled()
	})

	it('on a build command: chdir(projectPath) in the child BEFORE build, build(outputDir, projectPath, true, options), then send the result', async () => {
		const createHandler = await getCreateHandler()
		const { deps, buildSpy, callOrder } = makeDeps(async () => FIXTURE_APP)
		const handler = createHandler(deps)

		await handler(BUILD_MSG)

		expect(deps.chdir).toHaveBeenCalledWith(BUILD_MSG.projectPath)
		expect(buildSpy).toHaveBeenCalledWith(
			BUILD_MSG.outputDir,
			BUILD_MSG.projectPath,
			true,
			BUILD_MSG.options,
		)
		expect(
			callOrder,
			'chdir must happen before build — the compiler resolves project-relative paths off cwd (the whole reason the OLD architecture chdir-ed the host)',
		).toEqual(['chdir', 'build'])
		expect(deps.send).toHaveBeenCalledTimes(1)
		expect(deps.send).toHaveBeenCalledWith({ type: 'result', appInfo: FIXTURE_APP })
	})

	it('loads the compiler lazily on the FIRST build command and caches it across builds', async () => {
		const createHandler = await getCreateHandler()
		const { deps, buildSpy } = makeDeps(async () => FIXTURE_APP)
		const handler = createHandler(deps)

		expect(deps.loadCompiler).not.toHaveBeenCalled()
		await handler(BUILD_MSG)
		expect(deps.loadCompiler).toHaveBeenCalledTimes(1)
		await handler(BUILD_MSG)
		expect(
			deps.loadCompiler,
			'the compiler module must be loaded ONCE per worker lifetime and reused for every subsequent build',
		).toHaveBeenCalledTimes(1)
		expect(buildSpy).toHaveBeenCalledTimes(2)
		expect(deps.send).toHaveBeenCalledTimes(2)
	})

	it('normalizes a swallowed-error build (undefined return) to { type: "result", appInfo: null }', async () => {
		const createHandler = await getCreateHandler()
		// @dimina/compiler build() catches compile errors internally and
		// resolves undefined (RESULTS.md §① — never rethrows). The protocol
		// must surface that as an explicit null so the parent keeps its
		// existing project.config.json fallback path.
		const { deps } = makeDeps(async () => undefined)
		const handler = createHandler(deps)

		await handler(BUILD_MSG)

		expect(deps.send).toHaveBeenCalledTimes(1)
		expect(deps.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'result', appInfo: null }),
		)
	})

	it('a throwing build still replies ({ appInfo: null, error.message }) and never rejects the handler', async () => {
		const createHandler = await getCreateHandler()
		const { deps } = makeDeps(async () => {
			throw new Error('boom — compiler exploded')
		})
		const handler = createHandler(deps)

		// Must resolve — an unreplied build command would hang the parent's
		// in-flight rebuild and wedge the rebuild scheduler forever.
		await expect(handler(BUILD_MSG)).resolves.toBeUndefined()

		expect(deps.send).toHaveBeenCalledTimes(1)
		expect(deps.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'result',
				appInfo: null,
				error: expect.objectContaining({
					message: expect.stringContaining('boom'),
				}),
			}),
		)
	})
})

/**
 * Unit-testable seam for the fork-side PROCESS LIFECYCLE wiring.
 *
 * The orphan safety net ("worker kills itself when the fork IPC channel
 * dies") is BEHAVIORALLY pinned by the real-fork integration tests in
 * `compile-worker-leak.test.ts`. This describe pins the fast unit-level
 * guard: the message + disconnect wiring must be expressed through an
 * exported, dependency-injected function so the EXACT code the forked entry
 * runs is the code the unit suite exercises — mirroring how
 * `createCompileWorkerHandler` already made the message handling testable
 * without forking.
 *
 * Pinned export (seam form decided by this contract):
 *
 *   `wireCompileWorkerProcess(proc, handler): void`
 *     proc    = { on(event, listener), exit(code) } — `process` in the fork,
 *               a fake emitter here
 *     handler = the (msg) => Promise<void> built by createCompileWorkerHandler
 *
 *   Behavior:
 *     - subscribes 'message' → handler (every message forwarded)
 *     - subscribes 'disconnect' → proc.exit(0)  ← the orphan safety net
 *     - registers BOTH synchronously at call time (an async gap between fork
 *       and the disconnect subscription is a window where a dying parent
 *       leaks the child)
 *
 * The fork-mode self-wiring block must call THIS function with the real
 * `process` — keeping the inline `process.on('disconnect', …)` and adding a
 * parallel exported copy would let the two drift apart silently.
 */

type WorkerProcessLike = {
	on: (event: 'message' | 'disconnect', listener: (...args: unknown[]) => void) => unknown
	exit: (code?: number) => void
}
type WireWorkerProcess = (
	proc: WorkerProcessLike,
	handler: (msg: unknown) => Promise<void>,
) => void

class FakeWorkerProcess {
	listeners = new Map<string, Array<(...args: unknown[]) => void>>()
	exit = vi.fn((_code?: number) => {})
	on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
		const bucket = this.listeners.get(event) ?? []
		bucket.push(listener)
		this.listeners.set(event, bucket)
		return this
	})

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args)
	}
}

async function getWireWorkerProcess(): Promise<WireWorkerProcess> {
	const mod: unknown = await import('./compile-worker-entry.js' as string).catch(() => null)
	expect(mod, 'src/compile-worker-entry must exist').not.toBeNull()
	const fn = (mod as Record<string, unknown>).wireCompileWorkerProcess
	expect(
		typeof fn,
		'compile-worker-entry must export wireCompileWorkerProcess(proc, handler) — the process-lifecycle '
		+ 'wiring (message routing + disconnect self-exit) must be a unit-testable seam, exactly like '
		+ 'createCompileWorkerHandler already is for the message handling',
	).toBe('function')
	return fn as WireWorkerProcess
}

describe('compile-worker-entry — wireCompileWorkerProcess (orphan-safety-net seam)', () => {
	it('subscribes the disconnect self-exit SYNCHRONOUSLY at wire time, and never exits eagerly', async () => {
		const wire = await getWireWorkerProcess()
		const proc = new FakeWorkerProcess()

		wire(proc as unknown as WorkerProcessLike, async () => {})

		expect(
			proc.listeners.get('disconnect')?.length ?? 0,
			'the disconnect listener must be registered synchronously inside wireCompileWorkerProcess — '
			+ 'any async gap is a window where a dying parent orphans the worker',
		).toBeGreaterThanOrEqual(1)
		expect(
			proc.exit,
			'wiring alone must never exit the process',
		).not.toHaveBeenCalled()
	})

	it('on IPC disconnect the worker exits itself with code 0 — the orphan safety net', async () => {
		const wire = await getWireWorkerProcess()
		const proc = new FakeWorkerProcess()
		wire(proc as unknown as WorkerProcessLike, async () => {})

		proc.emit('disconnect')

		expect(
			proc.exit,
			'channel gone ⇒ the worker must kill ITSELF — this covers every parent death that never runs close() '
			+ '(host crash, SIGKILL, teardown race)',
		).toHaveBeenCalledWith(0)
	})

	it('routes every inbound IPC message to the provided handler (the forked path and the unit-tested path stay one code path)', async () => {
		const wire = await getWireWorkerProcess()
		const proc = new FakeWorkerProcess()
		const handled: unknown[] = []
		wire(proc as unknown as WorkerProcessLike, async (msg) => {
			handled.push(msg)
		})

		proc.emit('message', BUILD_MSG)
		proc.emit('message', { cmd: 'noop' })

		expect(handled).toEqual([BUILD_MSG, { cmd: 'noop' }])
		expect(proc.exit, 'message traffic must never exit the worker').not.toHaveBeenCalled()
	})
})

/**
 * The fork-mode self-wiring gate must NOT use a SUBSTRING match on
 * `process.argv[1]`: any unrelated script whose path merely contains
 * `compile-worker-entry` (run with an IPC channel, e.g. itself a fork) would
 * import this module and silently self-wire — a disconnect→exit(0) handler and
 * a message handler hijacking the host's IPC traffic. The gate must engage
 * ONLY when argv[1] is THIS module (same path as import.meta.url) — pinned
 * behaviorally below via a fresh module evaluation under a manipulated argv[1].
 *
 * Observation seam: self-wiring is `process.on('message'|'disconnect', …)` on
 * the REAL process — the tests diff the process listener sets around the
 * import and remove any added listeners again in cleanup (so a failing run
 * can never leak a disconnect→exit(0) handler into the vitest worker).
 */
describe('compile-worker-entry — fork-mode self-wiring gate', () => {
	type ListenerSnapshot = {
		message: Array<(...args: unknown[]) => void>
		disconnect: Array<(...args: unknown[]) => void>
	}

	function snapshotListeners(): ListenerSnapshot {
		return {
			message: process.listeners('message') as Array<(...args: unknown[]) => void>,
			disconnect: process.listeners('disconnect') as Array<(...args: unknown[]) => void>,
		}
	}

	function addedSince(before: ListenerSnapshot): ListenerSnapshot {
		const current = snapshotListeners()
		return {
			message: current.message.filter(listener => !before.message.includes(listener)),
			disconnect: current.disconnect.filter(listener => !before.disconnect.includes(listener)),
		}
	}

	function removeListeners(added: ListenerSnapshot): void {
		for (const listener of added.message) process.removeListener('message', listener)
		for (const listener of added.disconnect) process.removeListener('disconnect', listener)
	}

	async function importEntryFreshWithArgv1(argv1: string): Promise<void> {
		process.argv[1] = argv1
		vi.resetModules()
		await import('./compile-worker-entry.js' as string)
	}

	it('an argv[1] LOOKALIKE path (substring match) must NOT self-wire the worker IPC handlers', async () => {
		const originalArgv1 = process.argv[1] ?? ''
		const originalSend = process.send
		const before = snapshotListeners()
		try {
			// An IPC channel is present (vitest forks pool) or stubbed — the
			// substring gate is the only thing standing between this unrelated
			// script path and a hijacked process.
			if (typeof process.send !== 'function') {
				process.send = (() => true) as NonNullable<typeof process.send>
			}
			await importEntryFreshWithArgv1('/tmp/my-compile-worker-entry-lookalike.js')

			const added = addedSince(before)
			expect(
				added.disconnect,
				'argv[1] = /tmp/my-compile-worker-entry-lookalike.js is NOT this module — a substring gate self-wires '
				+ 'a disconnect→exit(0) handler into the unsuspecting host process',
			).toHaveLength(0)
			expect(
				added.message,
				'the lookalike path must not get a message handler either — it would intercept the host\'s own IPC traffic',
			).toHaveLength(0)
		}
		finally {
			removeListeners(addedSince(before))
			process.argv[1] = originalArgv1
			process.send = originalSend
			vi.resetModules()
		}
	})

	it('positive control: when argv[1] IS this entry module, the fork-mode self-wiring engages', async () => {
		const originalArgv1 = process.argv[1] ?? ''
		const originalSend = process.send
		const before = snapshotListeners()
		try {
			if (typeof process.send !== 'function') {
				process.send = (() => true) as NonNullable<typeof process.send>
			}
			const entryPath = fileURLToPath(new URL('./compile-worker-entry.ts', import.meta.url))
			await importEntryFreshWithArgv1(entryPath)

			const added = addedSince(before)
			expect(
				added.disconnect.length,
				'with argv[1] pointing at THIS module the self-wiring must engage (disconnect orphan safety net) — '
				+ 'a fix that simply disables the gate would orphan every real fork',
			).toBeGreaterThanOrEqual(1)
			expect(added.message.length, 'the real fork path must wire the message handler').toBeGreaterThanOrEqual(1)
		}
		finally {
			removeListeners(addedSince(before))
			process.argv[1] = originalArgv1
			process.send = originalSend
			vi.resetModules()
		}
	})
})
