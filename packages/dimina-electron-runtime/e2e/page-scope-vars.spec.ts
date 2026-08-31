/**
 * `page { ... }` in app.wxss compiles to `.dd-page[data-v-<scopeId>] { ... }`
 * (dimina compiler style-compiler.js) — the class AND the scope attribute are
 * both required for the rule to match anything. The render-host document only
 * puts scope attributes on the page's own vnode tree, never on `<body>`; it's
 * `installPageFrameStyleScopes` (dimina/fe render runtime) that copies the
 * scope attributes onto `<body>`, and it does so ONLY when `<body>` already
 * carries the `.dd-page` class — see render-host/pageFrame.html. Without that
 * class, every `page { ... }` rule in the app is dead: CSS custom properties
 * declared there never reach any element, and a `page { background-color }`
 * rule can't override the window-config default either.
 *
 * These assertions check computed style / actual values at runtime, not just
 * "does the HTML contain the class" — the class alone proves nothing if the
 * runtime scope-attribute wiring (a separate mechanism, out of this repo's
 * control) silently regresses.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect } from './fixtures'
import { openProject, evalInWebContentsByUrl, evalInSimulator, pollUntil, RENDER_GUEST_URL_MARKER } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'page-scope-vars-app')

// app.wxss: `page { --probe-token: 16px; background-color: #00aa55; }`
// pages/home/home.json: `"backgroundColor": "#ff00ff"` (window-config default).
const PROBE_TOKEN_VALUE = '16px'
const WXSS_BG_RGB = 'rgb(0, 170, 85)' // #00aa55 — must win
const WINDOW_CONFIG_BG_RGB = 'rgb(255, 0, 255)' // #ff00ff — must lose

test.describe('page {} global styles reach the render guest', () => {
  test('CSS custom property from page{} is readable on a page element, and page{} background-color beats window.backgroundColor', async ({ electronApp }) => {
    await openProject(electronApp, FIXTURE_DIR)

    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )

    // 1) `--probe-token` is declared only on `page {}` in app.wxss. Reading it
    // back on a normal page element proves it actually inherited down from
    // the page root (`.dd-page[data-v-*]` on `<body>`), not that it happens
    // to be set somewhere else.
    const tokenValue = await pollUntil(
      () => evalInWebContentsByUrl<string>(
        electronApp,
        RENDER_GUEST_URL_MARKER,
        `(() => {
          const el = document.querySelector('.probe')
          if (!el) return ''
          return getComputedStyle(el).getPropertyValue('--probe-token').trim()
        })()`,
      ).catch(() => ''),
      (val) => val === PROBE_TOKEN_VALUE,
      15000,
      300,
    )
    expect(tokenValue).toBe(PROBE_TOKEN_VALUE)

    // 2) pages/home/home.json sets window.backgroundColor (#ff00ff) — the
    // render-host preload primes the guest's `documentElement` with it for the
    // white-flash fix. app.wxss also sets `page { background-color: #00aa55 }`,
    // which compiles to `.dd-page[data-v-*]` and lands on `<body>`.
    //
    // Both are read in the SAME evaluation, and both are asserted: `<body>`
    // green alone would still pass if the window-config primer chain broke
    // entirely, because then nothing was ever there for the app's wxss to beat.
    // Pinning `<html>` at the window-config colour in the same instant is what
    // makes this a real "green won over magenta" assertion rather than just
    // "body is green".
    const backgrounds = await pollUntil(
      () => evalInWebContentsByUrl<string>(
        electronApp,
        RENDER_GUEST_URL_MARKER,
        `(() => JSON.stringify({
          html: getComputedStyle(document.documentElement).backgroundColor,
          body: getComputedStyle(document.body).backgroundColor,
        }))()`,
      ).catch(() => ''),
      (val) => {
        if (!val) return false
        const parsed = JSON.parse(val)
        return parsed.html === WINDOW_CONFIG_BG_RGB && parsed.body === WXSS_BG_RGB
      },
      15000,
      300,
    )
    const { html: htmlBg, body: bodyBg } = JSON.parse(backgrounds || '{}')
    expect(htmlBg, `expected the preload's window.backgroundColor primer to still hold ${WINDOW_CONFIG_BG_RGB} on <html>`).toBe(WINDOW_CONFIG_BG_RGB)
    expect(bodyBg, `expected page{}'s ${WXSS_BG_RGB} to win over window.backgroundColor's ${WINDOW_CONFIG_BG_RGB} on <body>`).toBe(WXSS_BG_RGB)
  })
})
