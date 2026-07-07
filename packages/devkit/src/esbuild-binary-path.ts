/**
 * ESBUILD_BINARY_PATH redirect for Electron app.asar hosts.
 *
 * esbuild's JS lib computes its native binary path from its own module
 * location. Packaged via electron-builder that location sits inside app.asar,
 * and `child_process.spawn` (unlike execFile) is not patched by Electron's
 * asar shim — spawning an in-asar path always fails ENOENT even though
 * asarUnpack put the real binary in app.asar.unpacked. esbuild honors the
 * ESBUILD_BINARY_PATH env var, so devkit points it at the unpacked binary.
 *
 * The platform packages lay their binary out differently (esbuild's own
 * pkgAndSubpathForCurrentPlatform): win32 ships `esbuild.exe` at the package
 * ROOT — there is no `bin/` directory — while every unix-like platform ships
 * `bin/esbuild`. Resolving the unix shape on win32 throws, and a swallowed
 * throw leaves the env var unset, which is exactly the packaged-Windows
 * failure mode this module guards against.
 *
 * All I/O is dependency-injected so the branching is unit-testable; index.ts
 * wires the real process/require/fs at module load.
 */
export interface ApplyEsbuildBinaryPathOptions {
	/** Caller module's directory — an `app.asar` segment means "packaged". */
	dirname: string
	/** process.env-like map, mutated in place. */
	env: Record<string, string | undefined>
	/** process.platform value. */
	platform: string
	/** process.arch value. */
	arch: string
	/** require.resolve-like; throws when the id cannot be resolved. */
	resolve: (id: string) => string
	/** fs.existsSync-like, probed against the rewritten unpacked path. */
	exists: (p: string) => boolean
	/** Diagnostics sink — every failure path reports here instead of going silent. */
	warn: (msg: string) => void
}

export function applyEsbuildBinaryPath(opts: ApplyEsbuildBinaryPathOptions): void {
	const { dirname, env, platform, arch, resolve, exists, warn } = opts
	if (env.ESBUILD_BINARY_PATH) return
	if (!dirname.includes('app.asar')) return
	const subpath = platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
	const id = `@esbuild/${platform}-${arch}/${subpath}`
	let resolved: string
	try {
		resolved = resolve(id)
	}
	catch {
		warn(`[devkit] could not resolve ${id} — esbuild's platform binary package is missing `
			+ 'from the packaged app, so the compiler cannot spawn esbuild. Ship the package '
			+ '(electron-builder dependency collection must include it) or set ESBUILD_BINARY_PATH.')
		return
	}
	// asarUnpack mirrors the archive's layout on disk — only the first app.asar
	// segment moves to app.asar.unpacked. A path already outside the archive
	// (or already unpacked) has no `app.asar/` segment and passes through as-is.
	const unpacked = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
	if (!exists(unpacked)) {
		warn(`[devkit] esbuild binary not found at ${unpacked} — the Electron host's packaging must `
			+ "asarUnpack '**/node_modules/esbuild/**' and '**/node_modules/@esbuild/**' so the native "
			+ 'binary exists outside app.asar (spawn cannot execute from inside the archive).')
	}
	env.ESBUILD_BINARY_PATH = unpacked
}
