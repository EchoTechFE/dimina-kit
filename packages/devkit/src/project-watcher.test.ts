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
	let handle: { close: () => Promise<void> } | undefined

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
})
