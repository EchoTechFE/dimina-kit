import { app } from 'electron'
import { launch } from './app/launch.js'
import { createGitHubReleaseChecker } from './services/update/index.js'

// Only a packaged RELEASE-channel build self-updates against this repo's
// GitHub Releases:
// - `pnpm dev` runs stay quiet (no API calls, no update dialog) — same
//   app.isPackaged gate used elsewhere for dev-only behavior.
// - A packaged DEV-channel build (release.yml's `channel: dev` — distributed
//   only as a 30-day Actions artifact for QA/branch testing, never a GitHub
//   Release) must NOT get this either: release.yml's dev channel never
//   creates a GitHub Release, so /releases/latest always reflects the
//   RELEASE channel — a dev build would be prompted to "update" to an
//   unrelated stable build, and clicking it would silently swap out the
//   very branch/PR build the person downloaded it to test. dev-channel
//   versions always carry bump-dev-version.js's `-dev.<timestamp>` suffix;
//   release-channel versions never do — use that as the channel signal.
// - Hosts that embed devtools via `launch(config)` supply their own
//   `updateChecker` (or none) and are unaffected — this default only
//   applies to this entry point.
//
// Custom parseVersion, NOT the default asset-name fallback and NOT
// 'trailing-number':
// - release.yml's GitHub Release tag (`release-YYYYMMDD-N`) is an unrelated
//   release-sequence label, not this app's version — 'trailing-number' would
//   compare its bare counter against app.getVersion() (e.g. "0.4.0")
//   numerically, which looks "newer" once the counter passes the app's major
//   version, reporting an update on every single check forever.
// - The built-in asset-name fallback (defaultParseVersion's SEMVER_RE) finds
//   the version inside `dimina-devtools-0.4.0-mac-arm64.dmg` (see release.yml's
//   "Rename macOS dmg" / Archive steps) but its optional prerelease-suffix
//   capture greedily swallows the trailing `-mac-arm64.dmg` as a "prerelease"
//   tag, so the update dialog would show a garbled "0.5.0-mac-arm64.dmg".
//   Extract just the clean `x.y.z` from our own known asset naming instead.
// Short-circuited: app.getVersion() must only be read once isPackaged is
// already known true, both because it's meaningless before then and because
// some minimal test/dev electron mocks don't stub getVersion() at all.
const updateChecker = app.isPackaged && !app.getVersion().includes('-dev.')
  ? createGitHubReleaseChecker({
      owner: 'EchoTechFE',
      repo: 'dimina-kit',
      parseVersion: (release) => {
        for (const asset of release.assets) {
          const match = /^dimina-devtools-(\d+\.\d+\.\d+)-/.exec(asset.name)
          if (match) return match[1]!
        }
        return null
      },
    })
  : undefined

// Fire-and-forget boot: launch() returns the electron-deck whenReady gate
// promise. A bare call would let a boot failure escape as an unhandledRejection
// (no diagnostics, can be swallowed). Surface it via a structured failure exit:
// log the cause and exit non-zero (per workbench-model.md fire-and-forget rule).
launch({ updateChecker }).catch((err: unknown) => {
  console.error('[devtools] fatal: launch() failed during boot', err)
  app.exit(1)
})
