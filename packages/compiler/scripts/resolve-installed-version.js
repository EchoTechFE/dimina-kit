import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'))
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// package.json only records the declared semver *range* (e.g. "^3.5.39");
// for a dep whose major is >=1 that range also matches later minors
// installed independently on each side. Walk the actual node_modules
// resolution the anchor's own package.json would use, and climb to the
// nearest package.json whose name matches (not just the first package.json
// found, which could belong to a nested dependency).
//
// requiredPrefix guards resolution landing outside a specific workspace root
// (e.g. dimina/fe nested inside this repo): if the anchor's own node_modules
// isn't installed, Node's resolution walks up past it and can silently land
// in an unrelated hoisted node_modules — "resolved" would then misreport an
// unrelated install as the answer. Reject any resolution that doesn't land
// under requiredPrefix instead of treating it as valid.
export async function resolveInstalledVersion(anchorPackageJsonPath, depName, requiredPrefix) {
  // Real ESM resolution (`import.meta.resolve`), not CJS `require.resolve`:
  // an ESM-only dep whose `exports` map lists only an `import` condition (no
  // `require`/`default` fallback) throws ERR_PACKAGE_PATH_NOT_EXPORTED under
  // CJS resolution — a real, correctly-installed package then gets
  // misreported as "unresolved" on BOTH sides, regardless of whether the two
  // sides actually agree on a version.
  //
  // `import.meta.resolve`'s second (parent) argument is NOT honored by
  // Node's node_modules directory search here — it silently resolves
  // relative to THIS module's own location no matter what parent URL is
  // passed, which would make every call below resolve from this module's
  // directory instead of the intended anchor. Spawning a child process with
  // `cwd` set to the anchor's own directory sidesteps that: single-arg
  // `import.meta.resolve(specifier)` correctly walks up from `cwd`.
  let entry
  try {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(depName)}))`],
      { cwd: path.dirname(anchorPackageJsonPath), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    entry = fileURLToPath(out.trim())
  } catch {
    return null
  }
  if (requiredPrefix && !entry.startsWith(requiredPrefix + path.sep)) {
    return null
  }
  let dir = path.dirname(entry)
  for (let hop = 0; hop < 16; hop++) {
    const candidate = path.join(dir, 'package.json')
    if (await exists(candidate)) {
      const pkg = await readJson(candidate)
      if (pkg.name === depName) return pkg.version
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
