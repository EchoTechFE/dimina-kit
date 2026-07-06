import { describe, expect, it, vi } from 'vitest'

/**
 * Contract for the compile worker ENTRY's warm-standby protocol extension.
 *
 * Devtools forks a project-agnostic "spare" compile worker while no project
 * is open and pre-loads its compiler toolchain, so the NEXT `openProject`
 * can adopt an already-warm process instead of paying fork+import+toolchain
 * load (~1.6s) cold. `createCompileWorkerHandler(deps)` gains an OPTIONAL
 * `warmPool?: () => Promise<void>` dependency and two new inbound message
 * kinds, alongside the existing `{ cmd: 'build' }` handling:
 *
 *  - `{ cmd: 'ping', id }` → a liveness probe used by the standby manager's
 *    health check. Replies `{ type: 'pong', id }` SYNCHRONOUSLY relative to
 *    the compiler — it must NEVER trigger `loadCompiler` (a health check on
 *    an otherwise-idle spare must not itself become a cold-load).
 *
 *  - `{ cmd: 'prewarm', id }` → loads the compiler (same lazy load + cache
 *    used by `{ cmd: 'build' }` — a build AFTER a successful prewarm must
 *    not reload it) and, if provided, awaits `deps.warmPool?.()`. Replies
 *    `{ type: 'prewarm-result', id, ok: true }` on success, or
 *    `{ type: 'prewarm-result', id, ok: false, error: message }` if either
 *    step throws/rejects — the handler itself must still resolve (a spare
 *    that dies quietly on a bad prewarm must not hang the parent that's
 *    waiting for the reply).
 *
 *  - Prewarm must NEVER call `deps.chdir` — this is the structural
 *    guarantee that makes adopting a project-agnostic spare safe: a spare
 *    that warmed up without chdir-ing into any project can be handed to
 *    ANY next-opened project unmodified.
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
type PongReply = { type: 'pong'; id: string }
type PrewarmReply = { type: 'prewarm-result'; id: string; ok: boolean; error?: string }
type OutboundMessage = WorkerResult | PongReply | PrewarmReply

type WorkerDeps = {
	loadCompiler: () => BuildFn | Promise<BuildFn>
	chdir: (dir: string) => void
	send: (msg: OutboundMessage) => void
	warmPool?: () => Promise<void>
}
type CreateHandler = (deps: WorkerDeps) => (msg: unknown) => Promise<void>

async function getCreateHandler(): Promise<CreateHandler> {
	const mod: unknown = await import('./compile-worker-entry.js' as string).catch(() => null)
	expect(mod, 'src/compile-worker-entry must exist').not.toBeNull()
	const fn = (mod as Record<string, unknown>).createCompileWorkerHandler
	expect(
		typeof fn,
		'compile-worker-entry must export createCompileWorkerHandler(deps)',
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

function makeDeps(
	build: BuildFn,
	warmPool?: () => Promise<void>,
): {
	deps: WorkerDeps
	buildSpy: ReturnType<typeof vi.fn>
	loadCompilerSpy: ReturnType<typeof vi.fn>
} {
	const buildSpy = vi.fn((...args: Parameters<BuildFn>) => build(...args))
	const loadCompilerSpy = vi.fn(() => buildSpy as unknown as BuildFn)
	const deps: WorkerDeps = {
		loadCompiler: loadCompilerSpy,
		chdir: vi.fn((_dir: string) => {}),
		send: vi.fn((_msg: OutboundMessage) => {}),
		...(warmPool ? { warmPool: vi.fn(warmPool) } : {}),
	}
	return { deps, buildSpy, loadCompilerSpy }
}

describe('compile-worker-entry — ping/prewarm (warm-standby protocol extension)', () => {
	it('ping replies pong synchronously and NEVER triggers loadCompiler', async () => {
		const createHandler = await getCreateHandler()
		const { deps, loadCompilerSpy } = makeDeps(async () => FIXTURE_APP)
		const handler = createHandler(deps)

		await handler({ cmd: 'ping', id: 'p1' })

		expect(
			loadCompilerSpy,
			'a ping health check must never load the compiler — a spare must be pingable while cold-idle',
		).not.toHaveBeenCalled()
		expect(deps.send).toHaveBeenCalledTimes(1)
		expect(deps.send).toHaveBeenCalledWith({ type: 'pong', id: 'p1' })
	})

	it('prewarm loads the compiler, calls warmPool if provided, and replies prewarm-result ok:true', async () => {
		const createHandler = await getCreateHandler()
		const warmPool = vi.fn(async () => {})
		const { deps, loadCompilerSpy } = makeDeps(async () => FIXTURE_APP, warmPool)
		const handler = createHandler(deps)

		await handler({ cmd: 'prewarm', id: 'w1' })

		expect(loadCompilerSpy).toHaveBeenCalledTimes(1)
		expect(
			deps.warmPool,
			'when warmPool is provided, prewarm must await it (after loadCompiler)',
		).toHaveBeenCalledTimes(1)
		expect(deps.send).toHaveBeenCalledWith({ type: 'prewarm-result', id: 'w1', ok: true })
	})

	it('a build AFTER a successful prewarm reuses the SAME cached compiler — loadCompiler is called exactly once total', async () => {
		const createHandler = await getCreateHandler()
		const { deps, buildSpy, loadCompilerSpy } = makeDeps(async () => FIXTURE_APP)
		const handler = createHandler(deps)

		await handler({ cmd: 'prewarm', id: 'w1' })
		await handler(BUILD_MSG)

		expect(
			loadCompilerSpy,
			'prewarm and the first build must share ONE compiler load/cache — a prewarmed spare that reloads on its first real build wastes the whole point of prewarming',
		).toHaveBeenCalledTimes(1)
		expect(buildSpy).toHaveBeenCalledTimes(1)
		expect(deps.send).toHaveBeenCalledTimes(2)
		expect(deps.send).toHaveBeenLastCalledWith(
			expect.objectContaining({ type: 'result', appInfo: FIXTURE_APP }),
		)
	})

	it('prewarm works without a warmPool dependency (it is OPTIONAL) — no crash, ok:true', async () => {
		const createHandler = await getCreateHandler()
		const { deps } = makeDeps(async () => FIXTURE_APP)
		const handler = createHandler(deps)

		await expect(handler({ cmd: 'prewarm', id: 'w2' })).resolves.toBeUndefined()

		expect(deps.send).toHaveBeenCalledWith({ type: 'prewarm-result', id: 'w2', ok: true })
	})

	it('prewarm replies ok:false with the error message when loadCompiler throws — the handler itself still resolves', async () => {
		const createHandler = await getCreateHandler()
		const failingLoad = vi.fn((): BuildFn => {
			throw new Error('boom — toolchain load failed')
		})
		const deps: WorkerDeps = {
			loadCompiler: failingLoad,
			chdir: vi.fn(),
			send: vi.fn(),
		}
		const handler = createHandler(deps)

		await expect(handler({ cmd: 'prewarm', id: 'w3' })).resolves.toBeUndefined()

		expect(deps.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'prewarm-result',
				id: 'w3',
				ok: false,
				error: expect.stringContaining('boom'),
			}),
		)
	})

	it('prewarm replies ok:false with the error message when warmPool rejects — the handler itself still resolves', async () => {
		const createHandler = await getCreateHandler()
		const warmPool = vi.fn(async () => {
			throw new Error('boom — pool warm-up failed')
		})
		const { deps } = makeDeps(async () => FIXTURE_APP, warmPool)
		const handler = createHandler(deps)

		await expect(handler({ cmd: 'prewarm', id: 'w4' })).resolves.toBeUndefined()

		expect(deps.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'prewarm-result',
				id: 'w4',
				ok: false,
				error: expect.stringContaining('boom'),
			}),
		)
	})

	it('prewarm NEVER calls chdir — the whole safety of a project-agnostic spare rests on this', async () => {
		const createHandler = await getCreateHandler()
		const { deps } = makeDeps(async () => FIXTURE_APP, async () => {})
		const handler = createHandler(deps)

		await handler({ cmd: 'prewarm', id: 'w5' })

		expect(
			deps.chdir,
			'prewarm must be project-agnostic: chdir-ing during prewarm would tie the spare to whatever project happened to be current at fork time',
		).not.toHaveBeenCalled()
	})
})
