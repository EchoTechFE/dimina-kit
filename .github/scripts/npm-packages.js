#!/usr/bin/env node

// Single source of truth for which workspace packages are npm-publishable.
// Order matters: dependency-first so consumers resolve already-published versions.
// fs-core → compiler → view-anchor → electron-deck → devkit → inspect → devtools.
//
// Consumed by both bump-dev-version.js (version bump) and publish-packages.js
// (actual publish) — a package missing here silently skips both dev-suffix
// versioning and publication, so add new publishable packages only here.
export const NPM_PACKAGES = [
  { name: '@dimina-kit/fs-core', dir: 'packages/fs-core' },
  { name: '@dimina-kit/compiler', dir: 'packages/compiler' },
  { name: '@dimina-kit/view-anchor', dir: 'packages/view-anchor' },
  { name: '@dimina-kit/electron-deck', dir: 'packages/electron-deck' },
  { name: '@dimina-kit/devkit', dir: 'packages/devkit' },
  { name: '@dimina-kit/inspect', dir: 'packages/inspect' },
  { name: '@dimina-kit/devtools', dir: 'packages/devtools' },
]
