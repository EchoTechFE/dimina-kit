#!/usr/bin/env node
/**
 * Electron peer/dev version sync gate. Fails if any workspace package's
 * `peerDependencies.electron` major version drifts from its own
 * `devDependencies.electron` major version.
 *
 * A published package's `devDependencies` are never installed by consumers —
 * only `dependencies`/`peerDependencies` are. So `peerDependencies.electron`
 * is the ONLY signal a downstream host (e.g. qdmp-devtools, which pins its
 * own separate `electron` devDependency) gets about which Electron major this
 * package was actually built and tested against. A stale, overly broad floor
 * like `>=36` lets that pin drift for months with zero warning — this check
 * forces whoever bumps `devDependencies.electron` to also touch
 * `peerDependencies.electron` in the same commit.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packagesRoot = join(here, '..', 'packages')

function firstMajor(range) {
	const match = /\d+/.exec(range)
	return match ? Number(match[0]) : null
}

const offenders = []
for (const name of readdirSync(packagesRoot)) {
	const pkgPath = join(packagesRoot, name, 'package.json')
	let pkg
	try {
		pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
	}
	catch {
		continue
	}

	const devRange = pkg.devDependencies?.electron
	const peerRange = pkg.peerDependencies?.electron
	if (!devRange || !peerRange) continue

	const devMajor = firstMajor(devRange)
	const peerMajor = firstMajor(peerRange)
	if (devMajor !== peerMajor) {
		offenders.push(
			`${name}: devDependencies.electron="${devRange}" (major ${devMajor}) `
			+ `!= peerDependencies.electron="${peerRange}" (major ${peerMajor})`,
		)
	}
}

if (offenders.length > 0) {
	console.error('[check-electron-peer-sync] peerDependencies.electron drifted from devDependencies.electron:')
	for (const o of offenders) console.error('  ' + o)
	console.error('Bump peerDependencies.electron to the same major when bumping devDependencies.electron.')
	process.exit(1)
}

console.log('[check-electron-peer-sync] OK — peerDependencies.electron matches devDependencies.electron in every package.')
process.exit(0)
