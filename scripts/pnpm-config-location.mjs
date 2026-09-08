import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which file currently holds a given pnpm config key, e.g. `overrides`.
 *
 * Gate scripts have to tell whoever they fail where to go and fix it, and
 * naming a file in prose goes stale silently: pnpm 12 stopped reading
 * `package.json#pnpm` and moved these keys to pnpm-workspace.yaml, which left
 * every message that said "the pnpm field in package.json" pointing at a file
 * that no longer has any effect. Looking the location up keeps the advice
 * correct across the next move too.
 *
 * Returns the file name, or null when the key is not declared anywhere yet —
 * callers decide what to say in that case, since where a NEW key should go is
 * a different question from where an existing one lives.
 */
export function locatePnpmConfigKey(repoRoot, key) {
	const workspaceFile = join(repoRoot, 'pnpm-workspace.yaml')
	if (existsSync(workspaceFile)) {
		// Top-level YAML keys start at column 0, which is enough to tell a real
		// declaration from the same word inside a comment or a nested value.
		const topLevelKey = new RegExp(`^${key}:`, 'm')
		if (topLevelKey.test(readFileSync(workspaceFile, 'utf8'))) return 'pnpm-workspace.yaml'
	}

	const rootManifest = join(repoRoot, 'package.json')
	if (existsSync(rootManifest)) {
		try {
			const pkg = JSON.parse(readFileSync(rootManifest, 'utf8'))
			if (pkg.pnpm && Object.hasOwn(pkg.pnpm, key)) return 'the `pnpm` field in package.json'
		}
		catch {
			// An unreadable root manifest is a different problem; the caller's
			// own failure is the one worth reporting.
		}
	}

	return null
}

/** The same lookup, phrased for a remediation message. */
export function describePnpmConfigKeyLocation(repoRoot, key) {
	const location = locatePnpmConfigKey(repoRoot, key)
	return location ?? 'whichever file pnpm reads config from (`pnpm config list --json` shows the resolved value)'
}
