import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectWatcher } from './index.js'

/**
 * Behavior tests for createProjectWatcher.
 *
 * These tests pin down the user-visible contract: when a developer edits
 * something inside their mini-app project, the watcher must fire onChange so
 * auto-compile can run. We deliberately use the real filesystem and real
 * chokidar — the suspected bug is in how chokidar is configured against
 * macOS reality, so any mocking would mask it.
 */

// macOS's os.tmpdir() lives under /var which is a symlink to /private/var.
// Some watcher configurations resolve symlinks and some don't; if we pass the
// /var path in but chokidar reports events under /private/var, every test
// would fail for the wrong reason. Normalize via realpath so the watcher
// path and the path we mutate match byte-for-byte.
function makeTempProject(): string {
	const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-watcher-'))
	return fs.realpathSync(raw)
}

// Give chokidar time to finish its initial scan before we start mutating.
// createProjectWatcher doesn't expose chokidar's 'ready' event, so a short
// settle delay is the practical option. 300ms is conservative on macOS.
const READY_DELAY_MS = 300

async function settle(ms = READY_DELAY_MS): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms))
}

describe('createProjectWatcher', () => {
	let tempDir: string
	let handle: { close: () => Promise<void>, ready: Promise<void> } | undefined

	beforeEach(() => {
		tempDir = makeTempProject()
		handle = undefined
	})

	afterEach(async () => {
		if (handle) {
			try {
				await handle.close()
			}
			catch {
				// ignore close errors during cleanup
			}
		}
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('fires onChange when an existing file is overwritten', async () => {
		// Why this matters: the bread-and-butter case — developer hits save in
		// their editor on an existing file (e.g. app.json) and expects a rebuild.
		const target = path.join(tempDir, 'app.json')
		fs.writeFileSync(target, '{}')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		fs.writeFileSync(target, '{"a":1}')

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('fires onChange when a brand-new file is created', async () => {
		// Why this matters: "I added a new page and nothing rebuilt" is one of
		// the most common auto-compile complaints.
		fs.mkdirSync(path.join(tempDir, 'pages'), { recursive: true })

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		fs.writeFileSync(path.join(tempDir, 'pages', 'new-page.js'), '// new')

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('fires onChange when a file is deleted', async () => {
		// Why this matters: removing a page should also trigger a rebuild so
		// route tables and asset manifests stay in sync.
		fs.mkdirSync(path.join(tempDir, 'pages'), { recursive: true })
		const target = path.join(tempDir, 'pages', 'index.js')
		fs.writeFileSync(target, '// initial')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		fs.unlinkSync(target)

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('fires onChange on atomic-save rename (editor writes temp file, renames over target)', async () => {
		// Why this matters: VS Code on macOS uses atomic-save by default — it
		// writes to app.json.tmp-xyz and renames it over app.json. If the
		// watcher only listens for direct writes, every save in VS Code looks
		// like nothing happened. We accept any number of onChange invocations
		// >= 1, since this single user action can naturally surface as either
		// an "add" or a "change" event in chokidar.
		const target = path.join(tempDir, 'app.json')
		fs.writeFileSync(target, '{}')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		const tmp = path.join(tempDir, 'app.json.tmp-xyz')
		fs.writeFileSync(tmp, '{"a":1}')
		fs.renameSync(tmp, target)

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('fires onChange for edits deep inside subdirectories', async () => {
		// Why this matters: mini-app source trees are always nested
		// (pages/index/index.wxml, components/foo/foo.js). If the watcher is
		// non-recursive or has a shallow depth setting, the most common files
		// in the project will silently fail to rebuild.
		const nestedDir = path.join(tempDir, 'pages', 'index')
		fs.mkdirSync(nestedDir, { recursive: true })
		const target = path.join(nestedDir, 'index.wxml')
		fs.writeFileSync(target, '<view></view>')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		fs.writeFileSync(target, '<view>updated</view>')

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('stays quiet when only .git internals change', async () => {
		// Why this matters: if the watcher picks up .git/HEAD shuffling or
		// other VCS bookkeeping, every `git checkout` or `git commit` triggers
		// a spurious rebuild — and worse, an auto-compile that itself touches
		// files can loop. The watcher must ignore .git entirely.
		const gitDir = path.join(tempDir, '.git')
		fs.mkdirSync(gitDir, { recursive: true })
		const head = path.join(gitDir, 'HEAD')
		fs.writeFileSync(head, 'ref: refs/heads/main\n')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		fs.writeFileSync(head, 'ref: refs/heads/other\n')

		// Negative assertion: wait a bit, then confirm no call happened.
		// We don't use vi.waitFor here because we're proving absence, not
		// presence — vi.waitFor would just burn the full timeout regardless.
		await settle(500)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('fires onChange for source edits when the project sits under a dotted ancestor directory', async () => {
		// Why this matters: regression for the bug where `ignored` was a regex
		// (/(^|[/\\])\../) matched against the full absolute path. When the
		// project lives under a dotted ancestor — e.g. a Claude worktree at
		// /…/.claude/worktrees/app — that regex matched the ancestor ".claude"
		// and chokidar ignored the entire project. Editing source then never
		// triggered a rebuild. The ancestor dot must NOT disable the watch;
		// only dotfiles/dirs *inside* the project should be ignored.
		const dottedAncestor = path.join(tempDir, '.claude', 'worktrees')
		const projectRoot = path.join(dottedAncestor, 'app')
		fs.mkdirSync(projectRoot, { recursive: true })
		const target = path.join(projectRoot, 'app.json')
		fs.writeFileSync(target, '{}')

		const onChange = vi.fn()
		handle = createProjectWatcher(projectRoot, onChange)
		await settle()

		fs.writeFileSync(target, '{"a":1}')

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('still ignores dotfiles inside a project that sits under a dotted ancestor directory', async () => {
		// Companion to the regression above: confirm the fix didn't over-correct
		// by disabling dot-ignoring entirely. A .git change *inside* the project
		// must stay quiet even though the project path itself contains a dotted
		// ancestor segment.
		const dottedAncestor = path.join(tempDir, '.claude', 'worktrees')
		const projectRoot = path.join(dottedAncestor, 'app')
		const gitDir = path.join(projectRoot, '.git')
		fs.mkdirSync(gitDir, { recursive: true })
		const head = path.join(gitDir, 'HEAD')
		fs.writeFileSync(head, 'ref: refs/heads/main\n')

		const onChange = vi.fn()
		handle = createProjectWatcher(projectRoot, onChange)
		await settle()

		fs.writeFileSync(head, 'ref: refs/heads/other\n')

		await settle(500)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('stops firing onChange after close() is called', async () => {
		// Why this matters: when a project session ends (user closes the
		// devtools window, switches projects), lingering watchers would keep
		// triggering rebuilds against stale state. close() must actually stop
		// the watcher.
		const target = path.join(tempDir, 'app.json')
		fs.writeFileSync(target, '{}')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		await handle.close()
		handle = undefined // prevent afterEach double-close

		// Clear any events that arrived during the ready window so we're only
		// measuring what happens after close().
		onChange.mockClear()

		fs.writeFileSync(target, '{"after":"close"}')

		await settle(500)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('stays quiet when a file inside node_modules changes', async () => {
		// Why this matters: a project with 87 dependencies puts chokidar under
		// watch for 1232+ directories inside node_modules, making close() take
		// seconds and letting dependency-internal file churn (postinstall
		// scripts, lockfile-driven reinstalls) trigger spurious rebuilds.
		// node_modules anywhere under the project — not just at the root — must
		// be excluded from the watch entirely.
		const nodeModulesDir = path.join(tempDir, 'node_modules', 'lodash')
		fs.mkdirSync(nodeModulesDir, { recursive: true })
		const target = path.join(nodeModulesDir, 'index.js')
		fs.writeFileSync(target, '// vendored')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await handle.ready

		fs.writeFileSync(target, '// vendored, changed')

		await settle(500)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('stays quiet when a file inside a nested package node_modules changes', async () => {
		// Why this matters: node_modules can recur at any depth (npm/pnpm
		// dependency trees, workspace packages with their own node_modules).
		// A watcher that only ignores the top-level node_modules segment would
		// still get flooded by these nested trees.
		const nestedNodeModules = path.join(tempDir, 'packages', 'a', 'node_modules', 'b')
		fs.mkdirSync(nestedNodeModules, { recursive: true })
		const target = path.join(nestedNodeModules, 'x.js')
		fs.writeFileSync(target, '// nested vendored')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await handle.ready

		fs.writeFileSync(target, '// nested vendored, changed')

		await settle(500)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('fires onChange for changes inside miniprogram_npm', async () => {
		// Why this matters: miniprogram_npm is the mini-app compiler's real
		// input — the built npm output that the compiler reads directly, not a
		// vendor tree to hide. A node_modules-ignoring rule that over-matches
		// (e.g. any path segment containing "node_modules" as a substring, or a
		// blanket "*npm*" pattern) would wrongly silence this directory too.
		const npmDir = path.join(tempDir, 'miniprogram_npm', 'some-pkg')
		fs.mkdirSync(npmDir, { recursive: true })
		const target = path.join(npmDir, 'index.js')
		fs.writeFileSync(target, '// built npm output')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await settle()

		fs.writeFileSync(target, '// built npm output, changed')

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('fires onChange for edits inside a `dist` directory (a mini-app may legitimately name a source dir dist/build)', async () => {
		// Why this matters: the compile watcher must NOT blanket-ignore build-tool
		// names like `dist`/`build` — app.json can declare pages/components under
		// arbitrary paths (e.g. `pages/build/index`), and the compiler reads them
		// as source. Only the perf-critical, never-source dirs (node_modules, VCS)
		// are ignored here; hiding `dist`/`build` is the devtools *editor mirror*'s
		// concern, not the recompile trigger's. The compiler's own output lands in
		// os.tmpdir(), outside the watched project, so there is no self-loop to fear.
		const distDir = path.join(tempDir, 'dist')
		fs.mkdirSync(distDir, { recursive: true })
		const target = path.join(distDir, 'index.js')
		fs.writeFileSync(target, '// page source')

		const onChange = vi.fn()
		handle = createProjectWatcher(tempDir, onChange)
		await handle.ready

		fs.writeFileSync(target, '// page source, changed')

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})

	it('fires onChange for source edits when the project itself sits under an ancestor node_modules directory', async () => {
		// Why this matters: same shape as the dotted-ancestor regression above —
		// a project can legitimately live inside a node_modules directory (e.g.
		// a demo/fixture project bundled inside a pnpm-installed package). Only
		// node_modules segments *under* projectPath should be ignored; an
		// ancestor node_modules segment must not disable the watch for the
		// project's own source.
		const ancestorNodeModules = path.join(tempDir, 'node_modules', 'some-demo-pkg')
		const projectRoot = path.join(ancestorNodeModules, 'demo-app')
		fs.mkdirSync(projectRoot, { recursive: true })
		const target = path.join(projectRoot, 'app.json')
		fs.writeFileSync(target, '{}')

		const onChange = vi.fn()
		handle = createProjectWatcher(projectRoot, onChange)
		await settle()

		fs.writeFileSync(target, '{"a":1}')

		await vi.waitFor(
			() => expect(onChange).toHaveBeenCalled(),
			{ timeout: 2000 },
		)
	})
})
