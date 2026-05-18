/**
 * Phase 2 contract: the two built-in template directories ship inside the
 * package at `<devtools>/templates/{blank,taro-todo}/` and `BUILTIN_TEMPLATES`
 * exposes them with absolute `source.path` values that point at those dirs.
 *
 * Bugs caught:
 *  - A refactor that moves templates/ but forgets to update the catalog
 *    would make BUILTIN_TEMPLATES point at a non-existent directory; every
 *    new-project click would fail with ENOENT.
 *  - `blank` missing the small files-of-life set (app.js/app.json/wxss/
 *    sitemap/project.config + pages/index) means scaffolded projects can't
 *    be opened by the simulator.
 *  - `taro-todo` not copied at all means picking it from the dialog ENOENTs.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_TEMPLATES } from './builtin-templates.js'

describe('BUILTIN_TEMPLATES', () => {
  it("exposes the 'blank' and 'taro-todo' templates with absolute, existing source.path values", () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id)
    expect(ids).toContain('blank')
    expect(ids).toContain('taro-todo')
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.source).toBeDefined()
      expect(path.isAbsolute(t.source!.path)).toBe(true)
      expect(fs.existsSync(t.source!.path)).toBe(true)
    }
  })

  it("the 'blank' template ships the canonical mini-program file set", () => {
    const blank = BUILTIN_TEMPLATES.find((t) => t.id === 'blank')!
    const dir = blank.source!.path
    // Files that the runtime / simulator hard-requires.
    expect(fs.existsSync(path.join(dir, 'app.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'app.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'app.wxss'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'project.config.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'sitemap.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pages', 'index', 'index.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pages', 'index', 'index.wxml'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pages', 'index', 'index.wxss'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pages', 'index', 'index.json'))).toBe(true)
  })

  it("the 'taro-todo' template ships its compiled-bundle file set (copied from dimina/fe/example/taro-todo)", () => {
    const taro = BUILTIN_TEMPLATES.find((t) => t.id === 'taro-todo')!
    const dir = taro.source!.path
    expect(fs.existsSync(path.join(dir, 'app.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'app.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'project.config.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pages', 'index', 'index.js'))).toBe(true)
    // Marker that distinguishes this from the blank template — taro-todo
    // ships a compiled vendor bundle.
    expect(fs.existsSync(path.join(dir, 'vendors.js'))).toBe(true)
  })

  it("the 'blank' app.json declares pages/index/index as a page", () => {
    const blank = BUILTIN_TEMPLATES.find((t) => t.id === 'blank')!
    const appJson = JSON.parse(
      fs.readFileSync(path.join(blank.source!.path, 'app.json'), 'utf-8'),
    ) as { pages?: string[] }
    expect(appJson.pages).toContain('pages/index/index')
  })
})
