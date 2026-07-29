const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function validPrerelease(prerelease) {
  if (prerelease === undefined) return true
  return prerelease
    .split('.')
    .every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))
}

export function parseSemver(version) {
  const match = SEMVER_RE.exec(version)
  if (!match || !validPrerelease(match[4])) {
    throw new Error(`Invalid SemVer version: ${version}`)
  }
  return {
    base: `${match[1]}.${match[2]}.${match[3]}`,
    prerelease: match[4] ?? null,
  }
}

export function toDevVersion(version, suffix) {
  const { base } = parseSemver(version)
  const candidate = `${base}-${suffix}`
  parseSemver(candidate)
  return candidate
}

export function isPrereleaseVersion(version) {
  return parseSemver(version).prerelease !== null
}
