import { describe, expect, it, vi } from 'vitest'
import { applyEsbuildBinaryPath, type ApplyEsbuildBinaryPathOptions } from './esbuild-binary-path.js'

/**
 * Contract for `applyEsbuildBinaryPath` — the ESBUILD_BINARY_PATH redirect
 * that lets esbuild spawn its native binary from app.asar.unpacked when
 * devkit runs packaged inside an Electron app.asar.
 *
 * The platform package layout differs by OS:
 *  - darwin/linux: `@esbuild/<platform>-<arch>/bin/esbuild`
 *  - win32: `@esbuild/win32-<arch>/esbuild.exe` at the package ROOT, no
 *    `bin/` dir. Resolving the darwin/linux shape on win32 throws, and a
 *    swallowed throw means ESBUILD_BINARY_PATH is silently never set —
 *    packaged Windows apps then fail with
 *    `spawn ...app.asar\node_modules\@esbuild\win32-x64\esbuild.exe ENOENT`.
 *
 * All I/O (require.resolve, fs.existsSync, console.warn, process.env) is
 * dependency-injected so the tests exercise pure branching logic.
 */

function makeOpts(overrides: Partial<ApplyEsbuildBinaryPathOptions> = {}): ApplyEsbuildBinaryPathOptions {
	return {
		dirname: 'C:\\Users\\x\\AppData\\Local\\Programs\\myapp\\resources\\app.asar\\packages\\devkit\\dist',
		env: {},
		platform: 'win32',
		arch: 'x64',
		resolve: vi.fn(() => {
			throw new Error('resolve not stubbed for this test')
		}),
		exists: vi.fn(() => true),
		warn: vi.fn(),
		...overrides,
	}
}

describe('applyEsbuildBinaryPath — no-op guards', () => {
	it('does nothing when ESBUILD_BINARY_PATH is already set', () => {
		const env = { ESBUILD_BINARY_PATH: '/already/set/esbuild' }
		const resolve = vi.fn()
		const exists = vi.fn()
		const warn = vi.fn()

		applyEsbuildBinaryPath(makeOpts({ env, resolve, exists, warn }))

		expect(env.ESBUILD_BINARY_PATH).toBe('/already/set/esbuild')
		expect(resolve).not.toHaveBeenCalled()
		expect(exists).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})

	it('does nothing when dirname is not inside an app.asar (unpackaged dev run)', () => {
		const env: Record<string, string | undefined> = {}
		const resolve = vi.fn()
		const exists = vi.fn()
		const warn = vi.fn()

		applyEsbuildBinaryPath(makeOpts({
			dirname: '/Users/dev/code/dimina-kit/packages/devkit/dist',
			env,
			resolve,
			exists,
			warn,
		}))

		expect(env.ESBUILD_BINARY_PATH).toBeUndefined()
		expect(resolve).not.toHaveBeenCalled()
		expect(exists).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})
})

describe('applyEsbuildBinaryPath — platform-correct binary subpath', () => {
	it('resolves the win32 package root exe, not bin/esbuild (the Windows bug)', () => {
		const resolve = vi.fn(() => 'C:\\app\\app.asar\\node_modules\\@esbuild\\win32-x64\\esbuild.exe')

		applyEsbuildBinaryPath(makeOpts({ platform: 'win32', arch: 'x64', resolve }))

		expect(resolve).toHaveBeenCalledWith('@esbuild/win32-x64/esbuild.exe')
		expect(resolve).not.toHaveBeenCalledWith('@esbuild/win32-x64/bin/esbuild')
	})

	it('resolves the darwin bin/esbuild subpath', () => {
		const resolve = vi.fn(() => '/app/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild')

		applyEsbuildBinaryPath(makeOpts({ platform: 'darwin', arch: 'arm64', resolve }))

		expect(resolve).toHaveBeenCalledWith('@esbuild/darwin-arm64/bin/esbuild')
	})

	it('resolves the linux bin/esbuild subpath', () => {
		const resolve = vi.fn(() => '/app/app.asar/node_modules/@esbuild/linux-x64/bin/esbuild')

		applyEsbuildBinaryPath(makeOpts({ platform: 'linux', arch: 'x64', resolve }))

		expect(resolve).toHaveBeenCalledWith('@esbuild/linux-x64/bin/esbuild')
	})
})

describe('applyEsbuildBinaryPath — app.asar → app.asar.unpacked rewrite', () => {
	it('rewrites the first app.asar\\ segment to app.asar.unpacked\\ on a Windows backslash path', () => {
		const env: Record<string, string | undefined> = {}
		const resolve = vi.fn(() =>
			'C:\\Users\\x\\AppData\\app.asar\\node_modules\\@esbuild\\win32-x64\\esbuild.exe',
		)

		applyEsbuildBinaryPath(makeOpts({ platform: 'win32', arch: 'x64', env, resolve }))

		expect(env.ESBUILD_BINARY_PATH).toBe(
			'C:\\Users\\x\\AppData\\app.asar.unpacked\\node_modules\\@esbuild\\win32-x64\\esbuild.exe',
		)
	})

	it('rewrites the first app.asar/ segment to app.asar.unpacked/ on a POSIX forward-slash path', () => {
		const env: Record<string, string | undefined> = {}
		const resolve = vi.fn(() => '/Applications/MyApp.app/Contents/Resources/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild')

		applyEsbuildBinaryPath(makeOpts({ platform: 'darwin', arch: 'arm64', dirname: '/Applications/MyApp.app/Contents/Resources/app.asar/packages/devkit/dist', env, resolve }))

		expect(env.ESBUILD_BINARY_PATH).toBe(
			'/Applications/MyApp.app/Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild',
		)
	})

	it('does not double-rewrite a resolved path that already contains app.asar.unpacked', () => {
		const env: Record<string, string | undefined> = {}
		const resolve = vi.fn(() =>
			'/Applications/MyApp.app/Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild',
		)

		applyEsbuildBinaryPath(makeOpts({ platform: 'darwin', arch: 'arm64', dirname: '/Applications/MyApp.app/Contents/Resources/app.asar/packages/devkit/dist', env, resolve }))

		expect(env.ESBUILD_BINARY_PATH).toBe(
			'/Applications/MyApp.app/Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild',
		)
	})
})

describe('applyEsbuildBinaryPath — resolve failure (the swallowed-throw half of the bug)', () => {
	it('does not throw, leaves env unset, and warns once naming the platform package when resolve throws', () => {
		const env: Record<string, string | undefined> = {}
		const resolve = vi.fn(() => {
			throw new Error("Cannot find module '@esbuild/win32-x64/esbuild.exe'")
		})
		const warn = vi.fn()

		expect(() => {
			applyEsbuildBinaryPath(makeOpts({ platform: 'win32', arch: 'x64', env, resolve, warn }))
		}).not.toThrow()

		expect(env.ESBUILD_BINARY_PATH).toBeUndefined()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('@esbuild/win32-x64'))
	})
})

describe('applyEsbuildBinaryPath — unpacked-path existence check', () => {
	it('still sets ESBUILD_BINARY_PATH and warns once with an asarUnpack hint when the unpacked path does not exist', () => {
		const env: Record<string, string | undefined> = {}
		const resolve = vi.fn(() => 'C:\\app\\app.asar\\node_modules\\@esbuild\\win32-x64\\esbuild.exe')
		const exists = vi.fn(() => false)
		const warn = vi.fn()

		applyEsbuildBinaryPath(makeOpts({ platform: 'win32', arch: 'x64', env, resolve, exists, warn }))

		expect(env.ESBUILD_BINARY_PATH).toBe('C:\\app\\app.asar.unpacked\\node_modules\\@esbuild\\win32-x64\\esbuild.exe')
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('asarUnpack'))
	})

	it('never warns when the unpacked path exists', () => {
		const resolve = vi.fn(() => 'C:\\app\\app.asar\\node_modules\\@esbuild\\win32-x64\\esbuild.exe')
		const exists = vi.fn(() => true)
		const warn = vi.fn()

		applyEsbuildBinaryPath(makeOpts({ platform: 'win32', arch: 'x64', resolve, exists, warn }))

		expect(warn).not.toHaveBeenCalled()
	})
})
