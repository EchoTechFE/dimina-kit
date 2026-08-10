/**
 * Android draws the nav-bar title left-aligned, so its start has to clear the
 * leading area. That area grows when the home button joins the back arrow, and
 * a title inset sized for the arrow alone runs underneath the second button.
 *
 * The geometry is read through `getComputedStyle` after loading
 * navigation-bar.css into the document, so the values come out of a real CSS
 * engine: selector matching (including descendant selectors against the shell's
 * own wrapper classes), document-order overriding, and shorthand-to-longhand
 * expansion all behave as they do for the rendered bar. jsdom performs no
 * layout, so the numbers are still the declared box metrics rather than
 * measured boxes — enough for an inset comparison, which is arithmetic over
 * declared widths.
 *
 * Two cascade rules jsdom does not implement, and how each is handled:
 * - Specificity: matching declarations are applied in document order alone. The
 *   stylesheet is single-class rules plus descendant overrides written after
 *   what they override, where document order and specificity agree.
 * - `@media`: rules inside a media block are dropped entirely, so a
 *   media-scoped override would be invisible here. The stylesheet is asserted
 *   to contain no media block, which turns that blind spot into a failure the
 *   moment one is added.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDefaultNavigationBarState, NavigationBar } from './navigation-bar'

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'navigation-bar.css')
const CSS = readFileSync(CSS_PATH, 'utf8')

let styleElement: HTMLStyleElement

beforeAll(() => {
  styleElement = document.createElement('style')
  styleElement.textContent = CSS
  document.head.appendChild(styleElement)
})

afterAll(() => {
  styleElement.remove()
})

/** A resolved length in px; an unset property counts as 0. */
function px(element: Element, property: string): number {
  const value = window.getComputedStyle(element).getPropertyValue(property)
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

interface BarOptions {
  homeButtonVisible: boolean
  /** The shell wrapper the bar renders inside — embedded drops the bezel. */
  embedded?: boolean
}

function renderBar({ homeButtonVisible, embedded = false }: BarOptions): HTMLElement {
  return render(
    <div className={`device-shell${embedded ? ' device-shell--embedded' : ''}`}>
      <NavigationBar
        state={makeDefaultNavigationBarState({ title: 'Detail', homeButtonVisible })}
        stackDepth={2}
        platform="android"
        statusBarHeight={24}
        navBarHeight={44}
      />
    </div>,
  ).container
}

/** Where the title's text starts, measured from the nav row's left edge. */
function titleStart(container: HTMLElement): number {
  const row = container.querySelector('.nav-bar__row')!
  const title = container.querySelector('.nav-bar__title')!
  return px(row, 'padding-left') + px(title, 'padding-left')
}

/** Where the leading buttons end, measured from the same edge. */
function leadingEnd(container: HTMLElement): number {
  const leading = container.querySelector('.nav-bar__leading')!
  const buttons = Array.from(leading.children)
  // Read the `gap` shorthand: jsdom resolves it, but does not expand it into
  // `column-gap`, which computes to the empty string here.
  const gap = px(leading, 'gap')
  const width = buttons.reduce((sum, button) => sum + px(button, 'width'), 0)
  return px(leading, 'left') + width + gap * Math.max(buttons.length - 1, 0)
}

describe('NavigationBar — Android title clears the leading buttons', () => {
  it('starts the title past both the back arrow and the home button', () => {
    const container = renderBar({ homeButtonVisible: true })

    expect(container.querySelectorAll('.nav-bar__leading > button')).toHaveLength(2)
    expect(titleStart(container)).toBeGreaterThanOrEqual(leadingEnd(container))
  })

  it('starts the title past a lone back arrow', () => {
    const container = renderBar({ homeButtonVisible: false })

    expect(container.querySelectorAll('.nav-bar__leading > button')).toHaveLength(1)
    expect(titleStart(container)).toBeGreaterThanOrEqual(leadingEnd(container))
  })

  it('keeps the inset when the shell renders the bar embedded', () => {
    const container = renderBar({ homeButtonVisible: true, embedded: true })

    expect(container.querySelectorAll('.nav-bar__leading > button')).toHaveLength(2)
    expect(titleStart(container)).toBeGreaterThanOrEqual(leadingEnd(container))
  })
})

describe('navigation-bar.css — stays inside the cascade this suite can resolve', () => {
  it('declares no media block, whose rules the computed style would drop', () => {
    expect(CSS).not.toMatch(/@media/)
  })
})
