/**
 * Regression coverage for two confirmed bugs found in adversarial review
 * before this checker was ever wired into production (see index.ts):
 *
 * 1. Version comparison must work against this repo's REAL release shape:
 *    release.yml's GitHub Release tag (`release-YYYYMMDD-N`) and release name
 *    carry no semver — only the asset filenames do
 *    (`dimina-devtools-0.4.0-mac-arm64.dmg`). The default ('semver') scheme's
 *    asset-name fallback (defaultParseVersion) must find it there and compare
 *    correctly against `app.getVersion()`. (The 'trailing-number' scheme,
 *    which was briefly wired here, compares the tag's bare `-N` counter
 *    directly against real semver like "0.4.0" — "5" > "0.4.0" numerically,
 *    so it reports "update available" on literally every check forever, even
 *    on the freshly-installed latest build.)
 * 2. downloadUpdate() must not silently accept a truncated transfer, and must
 *    not let an unhandled 'error' on the response stream crash the process —
 *    `.pipe()` does not forward source errors to the destination.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// NOT vi.hoisted: its callback runs eagerly, before the `EventEmitter` import
// binding above is initialized (TDZ). `vi.mock('https', …)` below is lazy —
// its factory only runs once `github-release-checker.js` is imported inside
// beforeEach, by which point this plain top-level const is long initialized.
class FakeIncomingMessage extends EventEmitter {
  statusCode: number
  headers: Record<string, string>
  constructor(statusCode = 200, headers: Record<string, string> = {}) {
    super()
    this.statusCode = statusCode
    this.headers = headers
  }
  resume() {}
  setEncoding() {}
  pipe(dest: NodeJS.WritableStream) {
    this.on('data', (chunk: Buffer) => dest.write(chunk))
    this.on('end', () => dest.end())
    return dest
  }
}
const harness = {
  FakeIncomingMessage,
  captured: [] as Array<{ url: string; res: FakeIncomingMessage }>,
  // Response headers for the NEXT https.get() call only — must be set before
  // invoking the checker, not on the returned `res`: the production code
  // reads `content-length` synchronously inside the https.get callback,
  // before any test code gets a chance to mutate `res.headers` afterwards.
  nextHeaders: undefined as Record<string, string> | undefined,
}

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
}))

vi.mock('https', () => {
  function get(url: string, _opts: unknown, callback: (res: unknown) => void) {
    const res = new harness.FakeIncomingMessage(200, harness.nextHeaders ?? {})
    harness.nextHeaders = undefined
    harness.captured.push({ url, res })
    callback(res)
    return { on: () => {} }
  }
  return { default: { get }, get }
})

let createGitHubReleaseChecker: typeof import('./github-release-checker.js').createGitHubReleaseChecker

beforeEach(async () => {
  harness.captured.length = 0
  ;({ createGitHubReleaseChecker } = await import('./github-release-checker.js'))
})

// defaultPickAsset filters release assets by the CURRENT process.platform/arch
// (correct production behavior — pick the asset matching the user's OS). A
// real release.yml run always ships all platform assets together in one
// release; a fixture with only a mac .dmg would find no match at all when
// this suite runs on a linux CI runner (process.platform === 'linux'), and
// checkForUpdates would fall through its unrelated `if (!asset) return null`
// regardless of whether the version comparison was correct — exactly the gap
// that let 3 of these tests pass locally on macOS and fail on CI. Ship one
// asset per platform/arch so whichever OS runs this suite finds a match.
function releaseJson(version: string): string {
  const names = [
    `dimina-devtools-${version}-mac-arm64.dmg`,
    `dimina-devtools-${version}-mac-x64.dmg`,
    `dimina-devtools-${version}-win-x64.zip`,
    `dimina-devtools-${version}-linux-x64.tar.gz`,
  ]
  return JSON.stringify({
    tag_name: 'release-20260706-5', // matches release.yml's real tag shape — no semver in it
    name: '',
    body: 'notes',
    prerelease: false,
    draft: false,
    assets: names.map((name) => ({ name, browser_download_url: `https://example.test/${name}`, size: 100 })),
  })
}

describe('createGitHubReleaseChecker: default (semver) scheme against real release.yml asset shape', () => {
  const checker = () => createGitHubReleaseChecker({ owner: 'EchoTechFE', repo: 'dimina-kit' })

  it('KNOWN LIMITATION: the built-in asset-name fallback finds a real update but garbles the version string', async () => {
    // SEMVER_RE's optional prerelease-suffix capture (`[-+]([0-9A-Za-z.-]+)`)
    // greedily swallows whatever text immediately follows the x.y.z in the
    // filename — for our own asset naming
    // (`dimina-devtools-<ver>-<platform>-<arch>.<ext>`) that's "-mac-arm64.dmg",
    // treated as a semver prerelease tag. Direction is still correct (still
    // flags 0.5.0 > 0.4.0 as an update), but showing "0.5.0-mac-arm64.dmg" in
    // the update dialog would be user-visibly wrong. This is exactly why
    // index.ts supplies its own `parseVersion` instead of relying on this
    // fallback — see entry-update-checker-wiring.test.ts.
    const infoPromise = checker().checkForUpdates('0.4.0')
    const { res } = harness.captured[0]!
    res.emit('data', releaseJson('0.5.0'))
    res.emit('end')

    await expect(infoPromise).resolves.toMatchObject({ version: '0.5.0-mac-arm64.dmg' })
  })

  it('does not falsely report an update when the release ships the same version', async () => {
    // Passes for a subtler reason than "0.4.0 == 0.4.0": the extracted
    // "0.4.0-mac-arm64.dmg" is semver-parsed as prerelease "mac-arm64.dmg" of
    // core 0.4.0, and semver defines prerelease < release-of-same-core — so
    // it still correctly sorts as "not newer" than the current "0.4.0".
    const infoPromise = checker().checkForUpdates('0.4.0')
    const { res } = harness.captured[0]!
    res.emit('data', releaseJson('0.4.0'))
    res.emit('end')

    await expect(infoPromise).resolves.toBeNull()
  })

  it('honors a custom parseVersion end-to-end (guards against the option silently stopping being wired to the parser)', async () => {
    // This is what index.ts actually supplies in production — a clean
    // extractor scoped to our own asset naming, sidestepping the
    // built-in fallback's garbled-suffix bug documented above. Exercising
    // it through the real checker (not a mock) catches the case where
    // `createGitHubReleaseChecker` stops honoring `opts.parseVersion`.
    const customChecker = createGitHubReleaseChecker({
      owner: 'EchoTechFE',
      repo: 'dimina-kit',
      parseVersion: (release) => {
        for (const asset of release.assets) {
          const m = /^dimina-devtools-(\d+\.\d+\.\d+)-/.exec(asset.name)
          if (m) return m[1]!
        }
        return null
      },
    })
    const infoPromise = customChecker.checkForUpdates('0.4.0')
    const { res } = harness.captured[0]!
    res.emit('data', releaseJson('0.5.0'))
    res.emit('end')

    await expect(infoPromise).resolves.toMatchObject({ version: '0.5.0' })
  })

  it('a bare trailing-number counter compared against real app semver is NOT a safe default (documents why index.ts must not use it)', async () => {
    // Same release payload, but parsed with the 'trailing-number' scheme
    // instead of the default — this is what index.ts used to wire and it
    // is the confirmed bug: "5" (from tag `release-20260706-5`) compares as
    // numerically greater than "0.4.0", so it "detects an update" against
    // the exact version already running.
    const trailingChecker = createGitHubReleaseChecker({
      owner: 'EchoTechFE',
      repo: 'dimina-kit',
      versionScheme: 'trailing-number',
    })
    const infoPromise = trailingChecker.checkForUpdates('0.4.0')
    const { res } = harness.captured[0]!
    res.emit('data', releaseJson('0.4.0'))
    res.emit('end')

    await expect(infoPromise).resolves.toMatchObject({ version: '5' })
  })
})

describe('downloadUpdate: transfer integrity', () => {
  const tmpFiles: string[] = []

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true })
  })

  it('resolves and writes the full file when the transfer completes cleanly', async () => {
    const checker = createGitHubReleaseChecker({ owner: 'EchoTechFE', repo: 'dimina-kit' })
    harness.nextHeaders = { 'content-length': '10' }
    const promise = checker.downloadUpdate({ version: '0.5.0', downloadUrl: 'https://example.test/app.dmg' })
    const { res } = harness.captured[0]!
    res.emit('data', Buffer.from('helloworld'))
    res.emit('end')

    const filePath = await promise
    tmpFiles.push(filePath)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('helloworld')
  })

  it('rejects (and does not leave a partial file) when the transfer is truncated', async () => {
    const checker = createGitHubReleaseChecker({ owner: 'EchoTechFE', repo: 'dimina-kit' })
    harness.nextHeaders = { 'content-length': '10' }
    const promise = checker.downloadUpdate({ version: '0.5.0', downloadUrl: 'https://example.test/app-truncated.dmg' })
    const { res } = harness.captured[0]!
    res.emit('data', Buffer.from('hello')) // only 5 of the promised 10 bytes
    res.emit('end')

    await expect(promise).rejects.toThrow(/truncated/i)
    const filePath = path.join(os.tmpdir(), 'dimina-kit-update', 'app-truncated.dmg')
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('rejects instead of crashing when the response stream errors mid-transfer', async () => {
    const checker = createGitHubReleaseChecker({ owner: 'EchoTechFE', repo: 'dimina-kit' })
    harness.nextHeaders = { 'content-length': '10' }
    const promise = checker.downloadUpdate({ version: '0.5.0', downloadUrl: 'https://example.test/app-reset.dmg' })
    const { res } = harness.captured[0]!
    res.emit('data', Buffer.from('hello'))
    res.emit('error', new Error('ECONNRESET'))

    await expect(promise).rejects.toThrow('ECONNRESET')
  })
})
