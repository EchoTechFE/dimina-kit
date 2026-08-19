/**
 * `NavigationBarState` producers: what a page's merged window config implies, and what the dynamic `wx.setNavigationBar*` / `wx.hideHomeButton` calls do to it afterwards.
 */
import { describe, it, expect } from 'vitest'
import { applyColorMutation, navBarFromConfig, reduceNavBar } from './navigation-bar-config.js'
import { makeDefaultNavigationBarState, type NavigationBarState } from './navigation-bar.js'

function makeNavBar(overrides: Partial<NavigationBarState> = {}): NavigationBarState {
  return makeDefaultNavigationBarState({
    title: '',
    backgroundColor: '#000000',
    textStyle: 'white',
    style: 'default',
    homeButtonVisible: false,
    loading: false,
    ...overrides,
  })
}

// ── navBarFromConfig ─────────────────────────────────────────────────────

describe('navBarFromConfig', () => {
  it('falls back to defaults (#ffffff bg, black text, default style) and uses fallback title when config is empty', () => {
    const state = navBarFromConfig({}, 'my-app-id')
    expect(state).toMatchObject({
      title: 'my-app-id',
      backgroundColor: '#ffffff',
      textStyle: 'black',
      style: 'default',
      homeButtonVisible: false,
    })
  })

  it('uses navigationBarTitleText when supplied (overriding the fallback)', () => {
    expect(navBarFromConfig({ navigationBarTitleText: 'Hello' }, 'fallback').title).toBe('Hello')
  })

  it('respects navigationBarTextStyle: white', () => {
    expect(navBarFromConfig({ navigationBarTextStyle: 'white' }, 'x').textStyle).toBe('white')
  })

  it('respects a custom navigationBarBackgroundColor', () => {
    expect(navBarFromConfig({ navigationBarBackgroundColor: '#abcdef' }, 'x').backgroundColor).toBe('#abcdef')
  })

  it("respects navigationStyle: 'custom'", () => {
    expect(navBarFromConfig({ navigationStyle: 'custom' }, 'x').style).toBe('custom')
  })

  it('shows the home button only when config.homeButton === true (strict equality)', () => {
    expect(navBarFromConfig({ homeButton: true }, 'x').homeButtonVisible).toBe(true)
    // Defensive: non-true truthy values are rejected.
    expect(navBarFromConfig({ homeButton: 1 as unknown as boolean }, 'x').homeButtonVisible).toBe(false)
  })
})

// ── reduceNavBar ─────────────────────────────────────────────────────────

describe('reduceNavBar', () => {
  it('setNavigationBarTitle updates the title field', () => {
    const next = reduceNavBar(makeNavBar({ title: 'old' }), 'setNavigationBarTitle', { title: 'new' })
    expect(next.title).toBe('new')
  })

  it('setNavigationBarColor delegates to applyColorMutation (frontColor white → textStyle white)', () => {
    const next = reduceNavBar(makeNavBar({ textStyle: 'black' }), 'setNavigationBarColor', { frontColor: '#ffffff' })
    expect(next.textStyle).toBe('white')
  })

  it('showNavigationBarLoading flips loading=true', () => {
    expect(reduceNavBar(makeNavBar({ loading: false }), 'showNavigationBarLoading', {}).loading).toBe(true)
  })

  it('hideNavigationBarLoading flips loading=false', () => {
    expect(reduceNavBar(makeNavBar({ loading: true }), 'hideNavigationBarLoading', {}).loading).toBe(false)
  })

  it('hideHomeButton flips homeButtonVisible=false', () => {
    expect(reduceNavBar(makeNavBar({ homeButtonVisible: true }), 'hideHomeButton', {}).homeButtonVisible).toBe(false)
  })

  it('returns the same state reference for unknown API names (no mutation, no throw)', () => {
    const prev = makeNavBar({ title: 'unchanged' })
    const next = reduceNavBar(prev, 'wxBananaApi', {})
    expect(next).toBe(prev)
  })
})

// ── applyColorMutation ────────────────────────────────────────────────────

describe('applyColorMutation', () => {
  it('frontColor #ffffff (any case) sets textStyle=white', () => {
    expect(applyColorMutation(makeNavBar({ textStyle: 'black' }), { frontColor: '#FFFFFF' }).textStyle).toBe('white')
  })

  it('frontColor #000000 sets textStyle=black', () => {
    expect(applyColorMutation(makeNavBar({ textStyle: 'white' }), { frontColor: '#000000' }).textStyle).toBe('black')
  })

  it('illegal frontColor (e.g. #ff0000) keeps the previous textStyle', () => {
    const prev = makeNavBar({ textStyle: 'white' })
    expect(applyColorMutation(prev, { frontColor: '#ff0000' }).textStyle).toBe('white')
  })

  it('passes through backgroundColor when supplied as a string', () => {
    expect(applyColorMutation(makeNavBar(), { backgroundColor: '#123456' }).backgroundColor).toBe('#123456')
  })

  it('animation: whitelisted timingFunc (easeIn) is preserved with duration in ms', () => {
    const next = applyColorMutation(makeNavBar(), {
      animation: { duration: 250, timingFunc: 'easeIn' },
    })
    expect(next.colorAnimation).toEqual({ durationMs: 250, timingFunc: 'easeIn' })
  })

  it("animation: non-whitelisted timingFunc (e.g. 'bounce') falls back to 'linear'", () => {
    const next = applyColorMutation(makeNavBar(), {
      animation: { duration: 100, timingFunc: 'bounce' },
    })
    expect(next.colorAnimation?.timingFunc).toBe('linear')
  })

  it('animation: NaN duration clamps to 0 (defensive)', () => {
    const next = applyColorMutation(makeNavBar(), {
      animation: { duration: Number.NaN, timingFunc: 'linear' },
    })
    expect(next.colorAnimation?.durationMs).toBe(0)
  })

  it('returns undefined colorAnimation when no animation field is supplied', () => {
    expect(applyColorMutation(makeNavBar(), {}).colorAnimation).toBeUndefined()
  })
})
