import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as devkit from './index.js'
import { writeUntilSettled } from './watch-rebuild.testutil.js'

/**
 * FLAKE HARDENING (no assertions changed): the watcher-rebuild test below uses
 * a REAL chokidar inotify watch + a REAL dmcc compile. Under CI load a single
 * fs.writeFileSync's inotify event can be dropped, hanging `await rebuilt`. The
 * count-agnostic waiter (`entries.length > 0`) re-writes the source file until
 * the rebuild fires; the rebuild scheduler coalesces the extra writes.
 */

/**
 * Contract for the `onLog` wiring in `openProject`.
 *
 *  - `OpenProjectOptions` carries
 *    `onLog?: (entry: { stream: 'stdout' | 'stderr'; text: string }) => void`.
 *  - BOTH compile paths — the first compile inside `openProject` and the
 *    watcher-driven `rebuild()` — deliver every dmcc line (already filtered
 *    through `filterDmccLogLine`) to `opts.onLog`, whether that compile
 *    succeeds or fails.
 *  - When `onLog` is NOT passed, no stdout/stderr capture is engaged:
 *    `process.stdout/stderr.write` and `isTTY` stay untouched during the build
 *    (zero-overhead contract, pinned by the last test).
 *  - A FIRST-compile failure rejects `openProject` itself — no session, no
 *    silent fallback to the `project.config.json` appid. `@dimina-kit/compiler`'s
 *    `build()` rejects instead of swallowing the compile error, the forked
 *    compile worker forwards it as an IPC error reply, and `compileWorker.build()`
 *    turns that into a rejected promise that `openProject` propagates verbatim.
 *    The failing stage and underlying reason still land on `opts.onLog` before
 *    the rejection — the log channel and the rejection surface the same failure.
 *
 * These are real integration tests: they run the actual `@dimina/compiler`
 * against a tiny generated fixture project in os.tmpdir() (~3s per compile,
 * validated by the spike's fixture probe).
 */

type LogEntry = { stream: 'stdout' | 'stderr'; text: string }

const cleanupRoots: string[] = []
const openSessions: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
	for (const session of openSessions.splice(0)) {
		try {
			await session.close()
		}
		catch {
			// best-effort teardown
		}
	}
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

function makeFixture(opts: { brokenIndexJs?: boolean } = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-compile-log-'))
	cleanupRoots.push(root)
	const write = (rel: string, content: string): void => {
		const target = path.join(root, rel)
		fs.mkdirSync(path.dirname(target), { recursive: true })
		fs.writeFileSync(target, content)
	}
	write('project.config.json', JSON.stringify({ appid: 'fixture_app_001', projectname: 'fixture-app' }))
	write('app.json', JSON.stringify({ pages: ['pages/index/index'] }))
	write('app.js', 'App({})\n')
	write('app.wxss', 'page { font-size: 14px; }\n')
	write('pages/index/index.json', '{}\n')
	write(
		'pages/index/index.js',
		opts.brokenIndexJs
			// Unbalanced brace + bad tokens — same corruption shape the spike used
			// to capture error.stderr.txt (esbuild transform failure).
			? 'Page({ data: { msg: "hi" } })\nconst broken = {{{ ;;; <<<\n'
			: 'Page({ data: { msg: "hi" } })\n',
	)
	write('pages/index/index.wxml', '<view>{{msg}}</view>\n')
	write('pages/index/index.wxss', '.x { color: red; }\n')
	return root
}

/** Noise patterns that must NEVER reach onLog (RESULTS.md §③ DROP rules). */
function expectNoNoise(texts: string[]): void {
	for (const text of texts) {
		expect(text.length, 'onLog must never receive an empty line').toBeGreaterThan(0)
		expect(text, 'logo / box-drawing banner lines must be filtered out').not.toMatch(/^[█╔╗╚╝═║\s]+$/)
		expect(text, '`❯ ` task-start lines must be filtered out').not.toMatch(/^❯ /)
		expect(text, '`› [██░░] %` progress-bar lines must be filtered out').not.toMatch(/^› \[/)
		expect(text, 'fe-server banner must be filtered out').not.toMatch(/^Server is running/)
		expect(text, 'fe-server banner must be filtered out').not.toMatch(/^Press Ctrl\+C/)
		expect(text, 'stack-trace frames must be filtered out').not.toMatch(/^\s+at /)
	}
}

describe('openProject onLog — first compile (integration, real dmcc)', () => {
	it('rejects openProject itself when the first compile fails, after streaming every filtered log line to onLog', async () => {
		const root = makeFixture({ brokenIndexJs: true })
		const entries: LogEntry[] = []
		const logOpts = { onLog: (entry: LogEntry) => entries.push(entry) }

		let caught: unknown
		try {
			const session = await devkit.openProject({
				projectPath: root,
				watch: false,
				outputDir: path.join(root, '.out'),
				...logOpts,
			})
			// Only reached if openProject wrongly resolved — track it for teardown
			// so a false-negative pass here still doesn't leak a dev server/watcher.
			openSessions.push(session)
		}
		catch (err) {
			caught = err
		}

		expect(
			caught,
			'openProject must REJECT when the first compile fails — a broken project must never silently open a session',
		).toBeInstanceOf(Error)
		const message = (caught as Error).message
		expect(
			message,
			'the rejection must name the failing stage, not a generic wrapper message',
		).toMatch(/stage "logic" failed/)
		expect(
			message,
			'the rejection must carry the underlying compile reason (esbuild transform failure), not just the stage name',
		).toMatch(/Transform failed/)

		expect(
			entries.length,
			'openProject must wire opts.onLog around the first build() — no lines were captured',
		).toBeGreaterThan(0)

		const texts = entries.map(entry => entry.text)
		expect(
			texts.some(text => /esbuild 转换失败/.test(text)),
			'the `[logic] esbuild 转换失败 <file>` line is the highest-value error line and must be kept',
		).toBe(true)
		expect(
			texts.some(text => /^✖ /.test(text)),
			'`✖ …[FAILED: …]` listr failure lines must be kept',
		).toBe(true)
		expect(
			texts.some(text => /编译出错: /.test(text)),
			'the `… 编译出错: …` summary line must be kept',
		).toBe(true)
		expectNoNoise(texts)

		for (const entry of entries) {
			expect(['stdout', 'stderr']).toContain(entry.stream)
			expect(typeof entry.text).toBe('string')
		}
		// dmcc emits the esbuild failure on stderr (error.stderr.txt line 1) —
		// the stream tag must say so, so the panel can style it as an error.
		const failure = entries.find(entry => /esbuild 转换失败/.test(entry.text))
		expect(failure?.stream).toBe('stderr')
	}, 60_000)

	it('streams filtered stage lines (✔ …) to onLog on a successful first compile', async () => {
		const root = makeFixture()
		const entries: LogEntry[] = []
		const logOpts = { onLog: (entry: LogEntry) => entries.push(entry) }

		const session = await devkit.openProject({
			projectPath: root,
			watch: false,
			outputDir: path.join(root, '.out'),
			...logOpts,
		})
		openSessions.push(session)

		expect(
			entries.length,
			'a successful compile must also stream its stage lines through onLog',
		).toBeGreaterThan(0)
		const texts = entries.map(entry => entry.text)
		expect(
			texts.some(text => /^✔ /.test(text)),
			'`✔ ` stage-completion lines must be kept (e.g. ✔ 输出编译产物)',
		).toBe(true)
		expectNoNoise(texts)

		// Stage lines are stdout (success.stdout.txt) — stream tags must match.
		const stage = entries.find(entry => /^✔ /.test(entry.text))
		expect(stage?.stream).toBe('stdout')
	}, 60_000)
})

describe('openProject onLog — watcher rebuild (integration, real dmcc)', () => {
	it('streams rebuild lines to onLog when the file watcher triggers a rebuild', async () => {
		const root = makeFixture()
		const entries: LogEntry[] = []
		const logOpts = { onLog: (entry: LogEntry) => entries.push(entry) }

		let resolveRebuilt: () => void = () => {}
		const rebuilt = new Promise<void>((resolve) => {
			resolveRebuilt = resolve
		})

		const session = await devkit.openProject({
			projectPath: root,
			watch: true,
			outputDir: path.join(root, '.out'),
			// rebuild() invokes onRebuild AFTER build() resolves, so by the time
			// this fires every rebuild log line has already been delivered.
			onRebuild: () => resolveRebuilt(),
			...logOpts,
		})
		openSessions.push(session)

		// Only count lines captured by the REBUILD build() call.
		entries.length = 0

		// Count-agnostic (entries.length > 0): re-write until the rebuild lands so
		// a dropped inotify event under CI load can't hang `await rebuilt`.
		await writeUntilSettled(
			rebuilt,
			path.join(root, 'pages', 'index', 'index.js'),
			attempt => `Page({ data: { msg: "updated-${attempt}" } })\n`,
		)

		expect(
			entries.length,
			'the rebuild() build() call must ALSO deliver to onLog — no rebuild lines reached onLog',
		).toBeGreaterThan(0)
		const texts = entries.map(entry => entry.text)
		expect(
			texts.some(text => /^✔ /.test(text)),
			'rebuild stage-completion lines must be kept',
		).toBe(true)
		expectNoNoise(texts)
	}, 60_000)
})

describe('openProject without onLog — zero-overhead contract (regression guard, green today)', () => {
	it('never swaps process.stdout/stderr.write nor touches isTTY during the build', async () => {
		const root = makeFixture()
		type MutableStream = { isTTY?: boolean; write: typeof process.stdout.write }
		const stdoutM = process.stdout as unknown as MutableStream
		const stderrM = process.stderr as unknown as MutableStream
		const before = {
			outWrite: stdoutM.write,
			errWrite: stderrM.write,
			outTTY: stdoutM.isTTY,
			errTTY: stderrM.isTTY,
		}

		let writeSwapped = false
		let ttyTouched = false
		let samples = 0
		// The build awaits worker threads / esbuild IPC, so the event loop turns
		// freely during the multi-second compile — the sampler reliably lands
		// inside the build window.
		const timer = setInterval(() => {
			samples += 1
			if (stdoutM.write !== before.outWrite || stderrM.write !== before.errWrite) {
				writeSwapped = true
			}
			if (stdoutM.isTTY !== before.outTTY || stderrM.isTTY !== before.errTTY) {
				ttyTouched = true
			}
		}, 1)

		try {
			const session = await devkit.openProject({
				projectPath: root,
				watch: false,
				outputDir: path.join(root, '.out'),
			})
			openSessions.push(session)
		}
		finally {
			clearInterval(timer)
		}

		expect(samples, 'sampler must have observed the build window').toBeGreaterThan(20)
		expect(
			writeSwapped,
			'without onLog the capture wrapper must NOT be engaged — write was swapped during the build',
		).toBe(false)
		expect(
			ttyTouched,
			'without onLog isTTY must stay untouched during the build',
		).toBe(false)
	}, 60_000)
})
