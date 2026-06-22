/**
 * Tests for the shared helper `getActivePageIframe`.
 *
 * Contract: return the last element in `document` with class
 * `dimina-native-webview__window`, cast as HTMLIFrameElement; return null if
 * no such element exists.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { getActivePageIframe } from './page-iframe.js'

const CLASS = 'dimina-native-webview__window'

function addIframe(): HTMLIFrameElement {
  const el = document.createElement('iframe')
  el.className = CLASS
  document.body.appendChild(el)
  return el
}

describe('getActivePageIframe', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns null when no .dimina-native-webview__window element exists', () => {
    expect(getActivePageIframe()).toBeNull()
  })

  it('returns the element when exactly one .dimina-native-webview__window exists', () => {
    const el = addIframe()
    expect(getActivePageIframe()).toBe(el)
  })

  it('returns the LAST element (document order) when multiple .dimina-native-webview__window exist', () => {
    addIframe() // first — should NOT be returned
    addIframe() // second — also not returned
    const last = addIframe() // third, last in DOM order — should be returned
    expect(getActivePageIframe()).toBe(last)
  })
})
