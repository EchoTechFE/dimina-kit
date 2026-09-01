import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const cssDir = join(here, '..', 'css')
const read = (name: string) => readFileSync(join(cssDir, name), 'utf8')

const cornetto = read('cornetto-tokens.css')
const tokens = read('tokens.css')
const base = read('base.css')
const deck = read('deck.css')

/** Custom properties a stylesheet DEFINES (`--x: value`). */
function declared(css: string): Set<string> {
  return new Set(css.match(/^\s*(--[\w-]+)\s*:/gm)?.map(m => m.trim().replace(/\s*:$/, '')) ?? [])
}

/** Custom properties a stylesheet READS (`var(--x)`). */
function referenced(css: string): Set<string> {
  return new Set(css.match(/var\(\s*(--[\w-]+)/g)?.map(m => m.replace(/var\(\s*/, '')) ?? [])
}

const defined = new Set([...declared(cornetto), ...declared(tokens)])

describe('every variable the stylesheets read is defined', () => {
  // Splitting design.css into three files is exactly the change that can drop
  // a variable on the floor: the rule that uses it and the :root that declares
  // it end up in different files, and a miss paints nothing rather than
  // failing loudly.
  it.each([
    ['tokens.css', tokens],
    ['base.css', base],
    ['deck.css', deck],
  ])('%s', (_name, css) => {
    const missing = [...referenced(css)].filter(v => !defined.has(v))
    expect(missing).toEqual([])
  })
})

describe('tailwind-preset.cjs', () => {
  const require_ = createRequire(import.meta.url)
  const preset = require_('../tailwind-preset.cjs') as {
    theme: { extend: Record<string, Record<string, unknown>> }
  }

  function presetVars(): string[] {
    const found = new Set<string>()
    for (const group of Object.values(preset.theme.extend)) {
      for (const value of Object.values(group)) {
        for (const v of referenced(JSON.stringify(value))) found.add(v)
      }
    }
    return [...found]
  }

  it('only aliases variables that tokens.css defines', () => {
    // An alias pointing at an undefined variable compiles fine and produces a
    // class that silently paints nothing.
    const missing = presetVars().filter(v => !defined.has(v))
    expect(missing).toEqual([])
  })

  it('aliases something', () => {
    // Guards the assertion above: an empty extract would make it vacuously pass.
    expect(presetVars().length).toBeGreaterThan(30)
  })
})

describe('light mode overrides', () => {
  const lightBlock = tokens.slice(tokens.indexOf('@media (prefers-color-scheme: light)'))
  const darkBlock = tokens.slice(0, tokens.indexOf('@media (prefers-color-scheme: light)'))

  it('introduces no variable that the dark baseline lacks', () => {
    // Dark is the baseline `:root`; the light block only resets values. A
    // variable that exists only under the light media query is invisible in
    // dark mode, which is the default.
    const darkVars = declared(darkBlock)
    const orphans = [...declared(lightBlock)].filter(v => !darkVars.has(v))
    expect(orphans).toEqual([])
  })

  it('lets a host force dark with the .dark class', () => {
    // In a light system the light block is what wins, so it has to opt out of
    // `.dark` — drop that guard and `.dark` silently becomes a no-op.
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\.dark\)\s*\{/,
    )
  })
})

describe('separator focus', () => {
  it('keeps a visible keyboard-focus ring', () => {
    // The `:focus` reset removes the outline the browser paints on a pointer
    // drag. Without a `:focus-visible` replacement a keyboard user cannot see
    // which divider they are on.
    const rule = base.match(/\[role="separator"\]:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/outline:\s*(?!none)\S/)
    expect([...referenced(rule)]).toContain('--color-ring')
  })
})
