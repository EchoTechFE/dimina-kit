import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveRuntimeAssetPaths } from './paths.js'

describe('resolveRuntimeAssetPaths', () => {
  let assetsRoot = ''

  beforeAll(() => {
    assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-runtime-assets-'))
    for (const relativePath of [
      'simulator/simulator.html',
      'preload/simulator.cjs',
      'render-host/pageFrame.html',
      'render-host/preload.cjs',
      'service-host/service.html',
      'service-host/preload.cjs',
      'native-host/service/service.js',
      'native-host/render/render.js',
      'native-host/common/common.js',
      'native-host/container/pageFrame.css',
    ]) {
      const target = path.join(assetsRoot, relativePath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
    }
  })

  afterAll(() => {
    fs.rmSync(assetsRoot, { recursive: true, force: true })
  })

  it('accepts a copied dist directory without relying on the module URL', () => {
    const assets = resolveRuntimeAssetPaths(assetsRoot)

    expect(assets.root).toBe(assetsRoot)
    expect(assets.simulatorDir).toBe(path.join(assetsRoot, 'simulator'))
    expect(assets.serviceHostPreloadPath).toBe(
      path.join(assetsRoot, 'service-host/preload.cjs'),
    )
  })

  it('reports incomplete bundled-host assets with the missing files', () => {
    expect(() => resolveRuntimeAssetPaths('/definitely/missing/dimina-assets'))
      .toThrow(/assetsRoot is incomplete.*simulator\/simulator\.html/)
  })

  it('rejects a copied dist directory whose native-host payload is incomplete', () => {
    const requiredNativeHostFile = path.join(
      assetsRoot,
      'native-host/service/service.js',
    )
    fs.rmSync(requiredNativeHostFile)
    try {
      expect(() => resolveRuntimeAssetPaths(assetsRoot))
        .toThrow(/missing: native-host\/service\/service\.js/)
    } finally {
      fs.writeFileSync(requiredNativeHostFile, '')
    }
  })
})
