/**
 * Regression coverage for MenuCapsule's close icon and NavigationBar's back
 * icon, matching dimina's native containers:
 * - close icon is a hollow ring + filled center dot (both platforms draw the
 *   same 22x22 canvas / r=7.8 ring / r=3.1 dot — DiminaActivity.kt
 *   MiniProgramCapsuleButton, DMPPageController.swift makeCapsuleCloseImage),
 *   not an "X" cross.
 * - back-arrow icon size differs per platform: iOS's arrow-back SVG asset is
 *   24pt, Android's Icons.AutoMirrored.Filled.KeyboardArrowLeft is 30dp.
 * - back-arrow is a filled wedge path (not a stroked chevron): iOS uses the
 *   exact path from arrow-back-{dark,light}.imageset; Android uses the
 *   standard Material Design "keyboard_arrow_left" glyph (verified against
 *   google/material-design-icons, since the compiled androidx vector has no
 *   source in this repo to read directly).
 */
import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MenuCapsule } from './menu-capsule'
import { NavigationBar, makeDefaultNavigationBarState } from './navigation-bar'

describe('MenuCapsule close icon', () => {
  it('renders a ring + center dot, not an X cross path', () => {
    const { container } = render(
      <MenuCapsule platform="ios" statusBarHeight={44} />
    )
    const closeSvg = container.querySelector('.menu-capsule__close svg')
    expect(closeSvg?.querySelectorAll('circle').length).toBe(2)
    expect(closeSvg?.querySelector('path')).toBeNull()
  })
})

describe('NavigationBar back icon size', () => {
  function renderWithBack(platform: 'ios' | 'android') {
    return render(
      <NavigationBar
        state={makeDefaultNavigationBarState()}
        stackDepth={2}
        platform={platform}
        statusBarHeight={platform === 'ios' ? 44 : 24}
        navBarHeight={44}
      />
    )
  }

  it('renders the iOS back arrow at 24px, matching the arrow-back SVG asset viewBox', () => {
    const { container } = renderWithBack('ios')
    const svg = container.querySelector('.nav-bar__back svg')
    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
  })

  it('renders the Android back arrow at 30px, matching KeyboardArrowLeft Modifier.size(30.dp)', () => {
    const { container } = renderWithBack('android')
    const svg = container.querySelector('.nav-bar__back svg')
    expect(svg?.getAttribute('width')).toBe('30')
    expect(svg?.getAttribute('height')).toBe('30')
  })

  it('renders the iOS back arrow as the exact arrow-back-{dark,light} filled path', () => {
    const { container } = renderWithBack('ios')
    const path = container.querySelector('.nav-bar__back svg path')
    expect(path?.getAttribute('d')).toBe('M17.51 3.87L15.73 2.1 5.84 12l9.9 9.9 1.77-1.77L9.38 12l8.13-8.13z')
    expect(path?.getAttribute('fill')).toBe('currentColor')
  })

  it('renders the Android back arrow as the standard Material keyboard_arrow_left filled path', () => {
    const { container } = renderWithBack('android')
    const path = container.querySelector('.nav-bar__back svg path')
    expect(path?.getAttribute('d')).toBe('M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z')
    expect(path?.getAttribute('fill')).toBe('currentColor')
  })
})
