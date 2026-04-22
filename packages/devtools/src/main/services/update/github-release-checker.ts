import fs from 'fs'
import path from 'path'
import https from 'https'
import type { IncomingMessage } from 'http'
import { app } from 'electron'
import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'

interface GitHubReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  tag_name: string
  name?: string
  body?: string
  prerelease: boolean
  draft: boolean
  assets: GitHubReleaseAsset[]
}

export type VersionScheme = 'semver' | 'trailing-number'

export interface GitHubReleaseCheckerOptions {
  owner: string
  repo: string
  /** Optional GitHub token (required for private repos; recommended to avoid rate limits). */
  token?: string
  /** Include prereleases when resolving the latest version. Default: false. */
  includePrereleases?: boolean
  /** Mark every delivered update as mandatory. Default: false. */
  mandatory?: boolean
  /**
   * Built-in version scheme. Ignored when `parseVersion` is supplied.
   * - `'semver'` (default): extract `x.y.z` from `tag_name` → release name → first asset name.
   * - `'trailing-number'`: treat the trailing `-<N>` in `tag_name` as the version
   *   (e.g. `release-20260422-1` → `'1'`). Compared as an integer.
   */
  versionScheme?: VersionScheme
  /**
   * Custom asset picker. Receives the release assets plus the current
   * process platform/arch. If omitted, a built-in picker is used that
   * matches by file extension and arch suffix.
   */
  pickAsset?: (assets: GitHubReleaseAsset[], ctx: PickAssetContext) => GitHubReleaseAsset | undefined
  /**
   * Extract the version string from a release. Overrides `versionScheme`.
   */
  parseVersion?: (release: GitHubRelease) => string | null
}

export interface PickAssetContext {
  platform: NodeJS.Platform
  arch: string
}

export function createGitHubReleaseChecker(opts: GitHubReleaseCheckerOptions): UpdateChecker {
  const releaseUrl = opts.includePrereleases
    ? `https://api.github.com/repos/${opts.owner}/${opts.repo}/releases`
    : `https://api.github.com/repos/${opts.owner}/${opts.repo}/releases/latest`

  const parseVersion = opts.parseVersion ?? schemeParser(opts.versionScheme ?? 'semver')

  return {
    async checkForUpdates(currentVersion: string): Promise<UpdateInfo | null> {
      const release = await fetchRelease(releaseUrl, opts)
      if (!release) return null

      const latestVersion = parseVersion(release)
      if (!latestVersion) return null
      if (compareSemver(latestVersion, stripV(currentVersion)) <= 0) return null

      const asset = (opts.pickAsset ?? defaultPickAsset)(release.assets, {
        platform: process.platform,
        arch: process.arch,
      })
      if (!asset) return null

      return {
        version: latestVersion,
        downloadUrl: asset.browser_download_url,
        releaseNotes: release.body,
        mandatory: opts.mandatory,
      }
    },

    async downloadUpdate(info: UpdateInfo, onProgress?: (percent: number) => void): Promise<string> {
      const tmpDir = path.join(app.getPath('temp'), `${opts.repo}-update`)
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

      const fileName = path.basename(new URL(info.downloadUrl).pathname)
      const filePath = path.join(tmpDir, fileName)

      await downloadFile(info.downloadUrl, filePath, opts.token, onProgress)
      return filePath
    },
  }
}

// ── Default pickers ───────────────────────────────────────────────────────

function defaultPickAsset(assets: GitHubReleaseAsset[], ctx: PickAssetContext): GitHubReleaseAsset | undefined {
  const candidates = platformMatchers(ctx.platform, ctx.arch)
  for (const match of candidates) {
    const hit = assets.find((a) => match(a.name))
    if (hit) return hit
  }
  return undefined
}

function platformMatchers(platform: NodeJS.Platform, arch: string): Array<(name: string) => boolean> {
  const lc = (s: string) => s.toLowerCase()
  const archTags = archAliases(arch)

  const hasArch = (name: string) => archTags.some((tag) => lc(name).includes(tag))
  const endsWith = (name: string, ext: string) => lc(name).endsWith(ext)

  switch (platform) {
    case 'darwin':
      return [
        (n) => endsWith(n, '.dmg') && hasArch(n),
        (n) => endsWith(n, '.dmg'), // mac builds are often universal / unarch-tagged
        (n) => endsWith(n, '.zip') && (lc(n).includes('mac') || lc(n).includes('darwin')),
      ]
    case 'win32':
      return [
        (n) => endsWith(n, '.exe') && hasArch(n),
        (n) => endsWith(n, '.zip') && (lc(n).includes('win') || lc(n).includes('windows')) && hasArch(n),
        (n) => endsWith(n, '.exe'),
        (n) => endsWith(n, '.zip') && (lc(n).includes('win') || lc(n).includes('windows')),
      ]
    case 'linux':
      return [
        (n) => endsWith(n, '.appimage') && hasArch(n),
        (n) => endsWith(n, '.tar.gz') && lc(n).includes('linux') && hasArch(n),
        (n) => endsWith(n, '.appimage'),
        (n) => endsWith(n, '.tar.gz') && lc(n).includes('linux'),
        (n) => endsWith(n, '.deb') && hasArch(n),
      ]
    default:
      return []
  }
}

function archAliases(arch: string): string[] {
  switch (arch) {
    case 'x64':
      return ['x64', 'x86_64', 'amd64']
    case 'arm64':
      return ['arm64', 'aarch64']
    case 'ia32':
      return ['ia32', 'x86', 'i386']
    default:
      return [arch]
  }
}

// ── Version parsing & comparison ──────────────────────────────────────────

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?/
const TRAILING_NUMBER_RE = /-(\d+)$/

function schemeParser(scheme: VersionScheme): (release: GitHubRelease) => string | null {
  if (scheme === 'trailing-number') {
    return (release) => {
      const m = release.tag_name.match(TRAILING_NUMBER_RE)
      return m ? m[1]! : null
    }
  }
  return defaultParseVersion
}

function defaultParseVersion(release: GitHubRelease): string | null {
  const fromTag = extractSemver(release.tag_name)
  if (fromTag) return fromTag
  if (release.name) {
    const fromName = extractSemver(release.name)
    if (fromName) return fromName
  }
  for (const asset of release.assets) {
    const hit = extractSemver(asset.name)
    if (hit) return hit
  }
  return null
}

function extractSemver(input: string): string | null {
  const m = input.match(SEMVER_RE)
  if (!m) return null
  const [, major, minor, patch, pre] = m
  return pre ? `${major}.${minor}.${patch}-${pre}` : `${major}.${minor}.${patch}`
}

function stripV(version: string): string {
  return version.replace(/^v/i, '')
}

function compareSemver(a: string, b: string): number {
  const [aCore, aPre] = splitPre(a)
  const [bCore, bPre] = splitPre(b)
  const [a1, a2, a3] = parseCore(aCore)
  const [b1, b2, b3] = parseCore(bCore)
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  if (a3 !== b3) return a3 - b3
  // Release > prerelease of same core.
  if (!aPre && bPre) return 1
  if (aPre && !bPre) return -1
  if (!aPre && !bPre) return 0
  return aPre!.localeCompare(bPre!)
}

function splitPre(v: string): [string, string | null] {
  const i = v.indexOf('-')
  return i < 0 ? [v, null] : [v.slice(0, i), v.slice(i + 1)]
}

function parseCore(core: string): [number, number, number] {
  const parts = core.split('.').map((s) => parseInt(s, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function ghHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'dimina-kit-updater',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchRelease(url: string, opts: GitHubReleaseCheckerOptions): Promise<GitHubRelease | null> {
  const body = await httpGetText(url, { headers: ghHeaders(opts.token) })
  if (!body) return null

  if (opts.includePrereleases) {
    const list = JSON.parse(body) as GitHubRelease[]
    const first = list.find((r) => !r.draft)
    return first ?? null
  }

  const release = JSON.parse(body) as GitHubRelease
  return release.draft ? null : release
}

function httpGetText(url: string, init: { headers: Record<string, string> }): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: init.headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(httpGetText(res.headers.location, init))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
  })
}

function downloadFile(
  url: string,
  dest: string,
  token: string | undefined,
  onProgress: ((percent: number) => void) | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = ghHeaders(token)
    // GitHub asset downloads redirect to signed S3 URLs; keep following them.
    const attempt = (target: string, redirectsLeft: number) => {
      const req = https.get(target, { headers }, (res: IncomingMessage) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'))
            return
          }
          attempt(res.headers.location, redirectsLeft - 1)
          return
        }

        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode} while downloading update`))
          return
        }

        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        const out = fs.createWriteStream(dest)

        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (total > 0 && onProgress) {
            onProgress((received / total) * 100)
          }
        })
        res.pipe(out)
        out.on('finish', () => { out.close(); resolve() })
        out.on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
      })
      req.on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
    }
    attempt(url, 5)
  })
}
