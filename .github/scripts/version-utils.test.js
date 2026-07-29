import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isPrereleaseVersion,
  parseSemver,
  toDevVersion,
} from './version-utils.js'

test('dev versions replace an existing prerelease instead of appending to it', () => {
  assert.equal(
    toDevVersion('0.3.0-dev.6', 'dev.20260729062524'),
    '0.3.0-dev.20260729062524',
  )
})

test('dev versions discard build metadata and preserve the core version', () => {
  assert.equal(
    toDevVersion('1.2.3+build.9', 'dev.20260729062524'),
    '1.2.3-dev.20260729062524',
  )
})

test('prerelease detection distinguishes release and prerelease versions', () => {
  assert.equal(isPrereleaseVersion('1.2.3'), false)
  assert.equal(isPrereleaseVersion('1.2.3-dev.4'), true)
})

test('invalid versions and suffixes fail before a package is published', () => {
  assert.throws(() => parseSemver('1.2'), /Invalid SemVer/)
  assert.throws(
    () => toDevVersion('1.2.3', 'dev.01'),
    /Invalid SemVer/,
  )
})
