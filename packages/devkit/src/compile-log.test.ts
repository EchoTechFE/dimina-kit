import { describe, expect, it } from 'vitest'
import * as devkit from './index.js'

/**
 * ROUND 2 (dmcc 日志链路) — TDD contract for the compile-log module
 * (NOT yet implemented).
 *
 * ⚠️ ARCHITECTURE-DECISION CHANGE (user-approved, 2026-06-12):
 * The original ROUND 2 contract had a second export, `withCapturedStdio`
 * (tee-style in-process stdout/stderr write-hook + isTTY=false hack). The
 * user has since decided that compilation moves OUT of the Electron main
 * process into a forked long-lived child process (root causes: global
 * `process.chdir` mutation, global stdout hook capturing unrelated logs,
 * compiler crashes taking down the host, listr2 TTY hacks). In a fork
 * architecture the parent reads `child.stdout/stderr` — no write-hook, no
 * isTTY mutation — so the entire `withCapturedStdio` describe block was
 * DELETED from this file (it pinned an architecture that no longer exists,
 * 8 tests removed from the RED ledger). Its replacement contracts live in
 * `src/compile-worker-entry.test.ts` (worker side) and
 * `src/compile-worker.test.ts` (parent orchestration). This is an explicit
 * architecture correction, not goalpost-moving on a failing implementation.
 *
 * Required contract (unchanged — pure function, architecture-independent):
 *  - A new module (e.g. `src/compile-log.ts`) exports, and `src/index.ts`
 *    RE-EXPORTS (same pattern as `createRebuildScheduler`):
 *
 *    `filterDmccLogLine(line: string): string | null` — pure line filter.
 *    Input is first stripped of ANSI escape sequences, then matched
 *    against DROP rules derived from the REAL dmcc output archived in
 *    `.repro/dmcc-log-spike/{success,error}.{stdout,stderr}.txt`:
 *      - logo / box-drawing banner lines (/^[█╔╗╚╝═║\s]+$/) and blank lines
 *      - `❯ ` listr task-start lines (transient noise; ✔/✖ cover them)
 *      - `› [██░░] %` progress-bar lines
 *      - `Server is running on port …` / `Press Ctrl+C to stop`
 *      - `/^\s+at /` stack-trace frames (esbuild/Node internals)
 *    Every line not matching a DROP rule is KEPT (default-keep): the
 *    `[logic]/[view]/[style]/[compat]` prefixed warnings, `✖ ` failure
 *    lines, `编译出错: ` summaries, `✔ ` stage-completion lines, and the
 *    `<stdin>:L:C: ERROR: …` esbuild detail lines must all survive.
 *    Returns the cleaned (ANSI-stripped) line, or null to drop.
 *
 * All sample lines in this file are copied VERBATIM from the spike archives
 * (see `.repro/dmcc-log-spike/RESULTS.md` §2/§3).
 */

type FilterFn = (line: string) => string | null

function getFilter(): FilterFn {
	const fn = (devkit as Record<string, unknown>).filterDmccLogLine
	expect(
		typeof fn,
		'devkit must export filterDmccLogLine(line): string | null — the pure dmcc noise filter (re-exported from the new compile-log module via src/index.ts)',
	).toBe('function')
	return fn as FilterFn
}

describe('filterDmccLogLine — DROP rules (real dmcc noise from the spike archives)', () => {
	// success.stdout.txt lines 4-9: the dmcc logo banner (art.js). Printed
	// only on the first build of a process, but must always be stripped.
	const LOGO_LINES = [
		'██████╗ ██╗███╗   ███╗██╗███╗   ██╗ █████╗',
		'██╔══██╗██║████╗ ████║██║████╗  ██║██╔══██╗',
		'██║  ██║██║██╔████╔██║██║██╔██╗ ██║███████║',
		'██║  ██║██║██║╚██╔╝██║██║██║╚██╗██║██╔══██║',
		'██████╔╝██║██║ ╚═╝ ██║██║██║ ╚████║██║  ██║',
		'╚═════╝ ╚═╝╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝',
	]

	it('drops every logo / box-drawing banner line', () => {
		const filter = getFilter()
		for (const line of LOGO_LINES) {
			expect(filter(line), `logo line must be dropped: ${JSON.stringify(line)}`).toBeNull()
		}
	})

	it('drops blank and whitespace-only lines (logo surroundings)', () => {
		const filter = getFilter()
		expect(filter('')).toBeNull()
		expect(filter('   ')).toBeNull()
		expect(filter('\t')).toBeNull()
	})

	it('drops `❯ ` listr task-start lines (transient — ✔/✖ already cover them)', () => {
		const filter = getFilter()
		// success.stdout.txt lines 11 / 21
		expect(filter('❯ 准备项目编译环境')).toBeNull()
		expect(filter('❯ 开始编译:demo-app')).toBeNull()
		expect(filter('❯ 编译页面逻辑')).toBeNull()
	})

	it('drops `› [██░░] %` progress-bar lines', () => {
		const filter = getFilter()
		// success.stdout.txt lines 25 / 32 / 43
		expect(filter('› [████░░░░░░░░░░░░░░░░░░░░░░░░░░] 12.50%')).toBeNull()
		expect(filter('› [██████████████████████████████] 100.00%')).toBeNull()
		expect(filter('› [███████░░░░░░░░░░░░░░░░░░░░░░░] 22.22%')).toBeNull()
	})

	it('drops the devkit fe-server lines (port is already surfaced via session.port)', () => {
		const filter = getFilter()
		// success.stdout.txt lines 56-57
		expect(filter('Server is running on port 52197')).toBeNull()
		expect(filter('Press Ctrl+C to stop')).toBeNull()
	})

	it('drops stack-trace frames (esbuild/Node internals)', () => {
		const filter = getFilter()
		// error.stderr.txt lines 20-29
		expect(filter('    at failureErrorWithLog (/Volumes/jdisk/code/dimina-kit/node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild/lib/main.js:1748:15)')).toBeNull()
		expect(filter('    at /Volumes/jdisk/code/dimina-kit/node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild/lib/main.js:1017:50')).toBeNull()
		expect(filter('    at Socket.emit (node:events:507:28)')).toBeNull()
		expect(filter('    at Pipe.onStreamRead (node:internal/stream_base_commons:189:23)')).toBeNull()
	})
})

describe('filterDmccLogLine — KEEP rules (real dmcc signal from the spike archives)', () => {
	it('keeps the `[logic]` esbuild transform-failure line (the highest-value error line)', () => {
		const filter = getFilter()
		// error.stderr.txt line 1
		const line = '[logic] esbuild 转换失败 /Volumes/jdisk/code/dimina-kit/packages/demo-app/pages/index/index.js: Transform failed with 1 error:'
		expect(filter(line), 'esbuild 转换失败 must be kept — it carries the failing file path').toBe(line)
	})

	it('keeps the esbuild `<stdin>:L:C: ERROR:` detail line (default-keep for unrecognized content)', () => {
		const filter = getFilter()
		// error.stderr.txt line 2 — the actual syntax-error location. It matches
		// no DROP rule and MUST survive: a whitelist-only filter would lose the
		// only line that tells the developer what is wrong.
		const line = '<stdin>:96:16: ERROR: Expected identifier but found "{"'
		expect(filter(line)).toBe(line)
	})

	it('keeps `[logic]/[view]/[style]/[compat]` prefixed warnings', () => {
		const filter = getFilter()
		// success.stderr.txt lines 1 / 2 / 10 / 11
		const lines = [
			'[logic] 检测到循环依赖: pages/component-test/component-test -> /components/nested-item/nested-item -> /components/nested-item/nested-item',
			'[compat] Unsupported wx API: wx.createInnerAudioContext (/pages/audio-test/audio-test.js:33)',
			'[view] 检测到循环依赖，跳过处理: /components/nested-item/nested-item',
			'[style] 检测到循环依赖: pages/component-test/component-test -> /components/nested-item/nested-item -> /components/nested-item/nested-item',
		]
		for (const line of lines) {
			expect(filter(line), `prefixed warning must be kept: ${JSON.stringify(line)}`).toBe(line)
		}
	})

	it('keeps `✖ ` listr failure lines (with the FAILED reason)', () => {
		const filter = getFilter()
		// error.stderr.txt lines 12 / 14
		const lines = [
			'✖ 编译页面逻辑 [FAILED: Transform failed with 1 error:',
			'✖ 开始编译:demo-app [FAILED: Transform failed with 1 error:',
		]
		for (const line of lines) {
			expect(filter(line)).toBe(line)
		}
	})

	it('keeps the `编译出错: ` summary line', () => {
		const filter = getFilter()
		// error.stderr.txt line 16
		const line = '/Volumes/jdisk/code/dimina-kit/packages/demo-app 编译出错: Transform failed with 1 error:'
		expect(filter(line)).toBe(line)
	})

	it('keeps `✔ ` stage-completion lines', () => {
		const filter = getFilter()
		// success.stdout.txt lines 13 / 33 / 53 / 55
		const lines = [
			'✔ 收集配置信息',
			'✔ 编译页面逻辑',
			'✔ 开始编译:demo-app',
			'✔ 输出编译产物',
		]
		for (const line of lines) {
			expect(filter(line)).toBe(line)
		}
	})
})

describe('filterDmccLogLine — ANSI stripping happens BEFORE rule matching', () => {
	it('strips ANSI from a kept line and returns the cleaned text', () => {
		const filter = getFilter()
		expect(filter('\u001B[32m✔\u001B[39m 收集配置信息')).toBe('✔ 收集配置信息')
	})

	it('drops an ANSI-wrapped progress line (rules apply to the stripped text)', () => {
		const filter = getFilter()
		// What a TTY listr renderer chunk looks like: erase-line + column-1
		// escapes around the same progress payload.
		expect(filter('\u001B[2K\u001B[1G› [██████████████████████████████] 100.00%')).toBeNull()
	})

	it('drops a line that is empty once ANSI is stripped', () => {
		const filter = getFilter()
		expect(filter('\u001B[2K\u001B[1G')).toBeNull()
	})
})
