/**
 * Regression: the navigation-bar title is a bare <h2> with no font-family of
 * its own, so it must inherit the sans-serif stack from dimina's global
 * app.scss reset. The simulator embeds the container through the library build
 * (container-runtime.js); when that build omits app.scss the title falls back
 * to the document's UA serif font. See container-runtime.js.
 */
import { test, expect, useSharedProject } from './fixtures'
import { DEMO_APP_DIR, evalInSimulator, pollUntil } from './helpers'

test.describe('Navigation bar typography', () => {
  test.setTimeout(90_000)

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitMs: 8000 } })

  test('navbar title inherits the sans-serif stack, not the UA serif default', async ({
    electronApp,
  }) => {
    const fontFamily = await pollUntil(
      () =>
        evalInSimulator<string>(
          electronApp,
          `(() => {
            const el = document.querySelector('.dimina-native-webview__navigation-title')
            return el ? getComputedStyle(el).fontFamily : ''
          })()`,
        ),
      (v) => v.length > 0,
    )

    // app.scss sets `body { font-family: …,PingFang SC,…,sans-serif }`; the
    // <h2> inherits it. Without the reset the computed value would not contain
    // any of these families.
    expect(fontFamily).toContain('PingFang SC')
  })
})
