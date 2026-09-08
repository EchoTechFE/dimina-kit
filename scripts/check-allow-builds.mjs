#!/usr/bin/env node
/**
 * allowBuilds completeness gate. Fails if any installed dependency runs an
 * install lifecycle script that `allowBuilds` does not decide on.
 *
 * `allowBuilds` is an exhaustive list by construction: once the key exists,
 * pnpm aborts the install (ERR_PNPM_IGNORED_BUILDS) as soon as a dependency
 * with a build script is missing from it. Nothing checked that it stayed
 * exhaustive, and nothing could: both CI install steps pass --ignore-scripts,
 * so the one place the omission surfaces is a developer's own `pnpm install`
 * — after a lockfile bump has already landed on main.
 *
 * The list is read back from pnpm itself rather than from a file, because
 * where it lives is not stable: pnpm 12 stopped reading `package.json#pnpm`
 * and moved these keys to pnpm-workspace.yaml. `pnpm config list --json`
 * reports the resolved value wherever it currently comes from.
 *
 * Exit codes: 0 clean, 1 undeclared build scripts found, 2 cannot measure.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePnpmConfigKeyLocation } from './pnpm-config-location.mjs'

const TAG = '[check-allow-builds]'
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall']

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
// Overridable so the gate itself can be exercised against a fixture tree
// instead of only against whatever this machine happens to have installed.
const storeRoot = process.env.CHECK_ALLOW_BUILDS_STORE ?? join(repoRoot, 'node_modules', '.pnpm')

function fail(message) {
	console.error(`${TAG} ${message}`)
	process.exit(2)
}

function readAllowBuilds() {
	let raw
	try {
		raw = execFileSync('pnpm', ['config', 'list', '--json'], { cwd: repoRoot, encoding: 'utf8' })
	}
	catch (error) {
		fail(`could not run \`pnpm config list --json\`: ${error.message}`)
	}

	let config
	try {
		config = JSON.parse(raw)
	}
	catch {
		fail('`pnpm config list --json` did not return JSON; cannot read allowBuilds.')
	}

	// A missing key is not "allow everything": pnpm blocks every build script
	// when nothing is declared, so an absent key is an empty decision map.
	return config.allowBuilds ?? {}
}

/**
 * Package name for one `node_modules/.pnpm` directory.
 *
 * Entries are `<name with / replaced by +>@<version>` and may carry a
 * `_<peer or patch hash>` suffix that contains further `@` characters, so the
 * version separator is the first `@` after position 0, not the last one.
 */
function packageNameFromStoreDir(dir) {
	const at = dir.indexOf('@', dir.startsWith('@') ? 1 : 0)
	if (at <= 0) return null
	return dir.slice(0, at).replace('+', '/')
}

/** Every installed dependency whose install pnpm would have to decide on. */
function scanInstalledBuildScripts() {
	if (!existsSync(storeRoot)) {
		fail(`${storeRoot} does not exist — run \`pnpm install\` first; an unmeasured tree is not a passing one.`)
	}

	const found = new Map()
	for (const dir of readdirSync(storeRoot)) {
		const name = packageNameFromStoreDir(dir)
		if (!name) continue

		const packageDir = join(storeRoot, dir, 'node_modules', ...name.split('/'))
		const manifestPath = join(packageDir, 'package.json')
		if (!existsSync(manifestPath)) continue
		// Sibling entries in the same node_modules are symlinks to other store
		// entries; only the real directory is this entry's own package.
		if (lstatSync(packageDir).isSymbolicLink()) continue

		let manifest
		try {
			manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
		}
		catch {
			continue
		}
		if (manifest.name && manifest.name !== name) continue

		const hooks = LIFECYCLE_SCRIPTS.filter(hook => typeof manifest.scripts?.[hook] === 'string')
		// pnpm also treats a package as needing a build when it ships a
		// binding.gyp, even with no script of its own to run.
		if (hooks.length === 0 && !existsSync(join(packageDir, 'binding.gyp'))) continue

		const reason = hooks.length > 0 ? hooks.join(', ') : 'binding.gyp'
		const versions = found.get(name) ?? new Map()
		versions.set(manifest.version ?? dir, reason)
		found.set(name, versions)
	}
	return found
}

const allowBuilds = readAllowBuilds()
const installed = scanInstalledBuildScripts()

if (installed.size === 0) {
	fail(`scanned ${storeRoot} and found no package with an install script at all — that is implausible, so treat the scan as broken rather than clean.`)
}

const undeclared = []
for (const [name, versions] of installed) {
	if (Object.hasOwn(allowBuilds, name)) continue
	for (const [version, reason] of versions) {
		undeclared.push(`${name}@${version} (${reason})`)
	}
}

// Declared but no longer installed. Not a failure: the entry may cover a
// platform-specific dependency that this machine's tree does not contain.
const stale = Object.keys(allowBuilds).filter(name => !installed.has(name))

if (undeclared.length > 0) {
	console.error(`${TAG} these installed dependencies run an install script that allowBuilds does not decide on:`)
	for (const line of undeclared.sort()) console.error(`  ${line}`)
	console.error('')
	console.error(`Read each package's own script, then add it to \`allowBuilds\` in ${describePnpmConfigKeyLocation(repoRoot, 'allowBuilds')}`)
	console.error('as `true` (the build is needed) or `false` (running it changes nothing here), with a')
	console.error('comment saying which. Leaving one out makes `pnpm install` fail with ERR_PNPM_IGNORED_BUILDS.')
	process.exit(1)
}

console.log(`${TAG} OK — allowBuilds decides on all ${installed.size} installed package(s) with an install script.`)
if (stale.length > 0) {
	console.log(`${TAG} note: declared but not installed on this platform: ${stale.sort().join(', ')}`)
}
console.log(`${TAG} scanned ${storeRoot}; this only sees the current platform's tree.`)
process.exit(0)
