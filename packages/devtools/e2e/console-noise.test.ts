import { describe, expect, it } from 'vitest'
import { classifyConsoleSurface, isNonAppConsoleNoise, type ConsoleErrorEntry } from './console-noise'

/**
 * Our own renderer's bundle lives under a path that contains the literal
 * substring "devtools" (the package name), so any filter keying off that
 * word instead of the `devtools://` protocol misclassifies every real error
 * from this page as noise.
 */
const OWN_RENDERER_URL =
  'file:///Volumes/jdisk/code/dimina-kit/packages/devtools/dist/renderer/entries/workbench/index.html'

function entry(overrides: Partial<ConsoleErrorEntry>): ConsoleErrorEntry {
  return {
    level: 'error',
    message: '',
    url: '',
    source: '',
    ...overrides,
  }
}

describe('isNonAppConsoleNoise: real app errors must survive the filter', () => {
  it('keeps an Uncaught TypeError whose url/source are our own renderer bundle path', () => {
    const result = isNonAppConsoleNoise(
      entry({
        message: 'Uncaught TypeError: Cannot read properties of undefined (reading \'foo\')',
        url: OWN_RENDERER_URL,
        source: OWN_RENDERER_URL,
      }),
    )
    // The path contains "packages/devtools" — matching that substring against
    // "DevTools" is what makes every real renderer error disappear.
    expect(result).toBe(false)
  })

  it('keeps an application warning emitted from our own renderer bundle path', () => {
    const result = isNonAppConsoleNoise(
      entry({
        level: 'warning',
        message: 'Warning: a component is changing a controlled input to be uncontrolled',
        url: OWN_RENDERER_URL,
        source: OWN_RENDERER_URL,
      }),
    )
    expect(result).toBe(false)
  })

  it('keeps a real error whose message happens to mention the word "devtools" but whose url/source are our own renderer', () => {
    const result = isNonAppConsoleNoise(
      entry({
        message: 'Uncaught Error: failed to open the built-in devtools inspector for this project',
        url: OWN_RENDERER_URL,
        source: OWN_RENDERER_URL,
      }),
    )
    // Only `devtools://` in source/url identifies Chromium's own DevTools
    // front-end; the word "devtools" appearing in a message must not count.
    expect(result).toBe(false)
  })
})

describe('isNonAppConsoleNoise: real noise sources must stay filtered', () => {
  it('drops a CDP error reported by Chromium DevTools front-end (url is devtools://)', () => {
    const result = isNonAppConsoleNoise(
      entry({
        message: 'Network.loadNetworkResource … Frame not found',
        url: 'devtools://devtools/bundled/panels/network/network.js',
        source: 'devtools://devtools/bundled/panels/network/network.js',
      }),
    )
    expect(result).toBe(true)
  })

  it('drops a DevTools front-end error when only source is devtools:// and url is empty', () => {
    const result = isNonAppConsoleNoise(
      entry({
        message: 'Uncaught (in promise) Error',
        url: '',
        source: 'devtools://devtools/bundled/core/sdk/sdk.js',
      }),
    )
    expect(result).toBe(true)
  })

  it('drops messages carrying known resource/network-noise text (favicon, Failed to load resource, net::ERR_FILE_NOT_FOUND)', () => {
    expect(
      isNonAppConsoleNoise(entry({ message: 'Failed to load resource: net::ERR_FILE_NOT_FOUND', url: OWN_RENDERER_URL })),
    ).toBe(true)
    expect(
      isNonAppConsoleNoise(entry({ message: 'GET file:///favicon.ico net::ERR_FILE_NOT_FOUND', url: OWN_RENDERER_URL })),
    ).toBe(true)
  })

  it('drops A2 workbench startup chatter identified by ExtensionHost/a2-spike markers in source or url', () => {
    expect(
      isNonAppConsoleNoise(
        entry({
          message: 'Extension host terminated unexpectedly',
          source: 'https://127.0.0.1:5173/a2-spike/out/vs/workbench/api/node/localExtensionHostProcess.js',
        }),
      ),
    ).toBe(true)
    expect(
      isNonAppConsoleNoise(
        entry({
          message: 'setting up sandbox',
          url: 'https://127.0.0.1:5173/a2-spike/out/vs/code/electron-sandbox/workbench/workbench.js',
        }),
      ),
    ).toBe(true)
  })

  it('drops the A2 workbench settings-schema and workspace-mirror startup messages', () => {
    expect(
      isNonAppConsoleNoise(entry({ message: "json.schemas is not a registered configuration" })),
    ).toBe(true)
    expect(
      isNonAppConsoleNoise(entry({ message: "Unable to resolve nonexistent file '/workspace'" })),
    ).toBe(true)
  })
})

describe('classifyConsoleSurface: scheme prefix decides ownership, not substring presence', () => {
  it('classifies Chromium DevTools front-end as "devtools" even though its query string embeds an unrelated https:// URL', () => {
    // The https:// remoteBase lives inside the query string, after the
    // devtools: scheme. A substring-based check would see "https://" and
    // could misroute this to "workbench"; only the leading scheme is authoritative.
    const result = classifyConsoleSurface({
      url: 'devtools://devtools/bundled/devtools_app.html?remoteBase=https://chrome-devtools-frontend.appspot.com/...',
      source: '',
    })
    expect(result).toBe('devtools')
  })

  it('classifies the embedded A2 workbench origin (http://127.0.0.1:<port>/…) as "workbench"', () => {
    const result = classifyConsoleSurface({
      url: 'http://127.0.0.1:53694/w/11111111-1111-1111-1111-111111111111/index.html?theme=dark',
      source: '',
    })
    expect(result).toBe('workbench')
  })

  it('classifies our own file:// renderer bundle as "app"', () => {
    const result = classifyConsoleSurface({
      url: 'file:///Volumes/jdisk/code/dimina-kit/packages/devtools/dist/renderer/entries/workbench/index.html',
      source: '',
    })
    expect(result).toBe('app')
  })

  it('falls back to source and classifies as "devtools" when url is empty (worker/iframe cannot report a page url)', () => {
    const result = classifyConsoleSurface({
      url: '',
      source: 'devtools://devtools/bundled/core/sdk/sdk.js',
    })
    expect(result).toBe('devtools')
  })

  it('falls back to source and classifies as "workbench" when url is empty', () => {
    const result = classifyConsoleSurface({
      url: '',
      source: 'https://127.0.0.1:5173/a2-spike/out/vs/workbench/api/node/localExtensionHostProcess.js',
    })
    expect(result).toBe('workbench')
  })

  it('classifies as "app" when both url and source are empty, so an unattributable error fails a test instead of vanishing', () => {
    const result = classifyConsoleSurface({ url: '', source: '' })
    expect(result).toBe('app')
  })
})

describe('isNonAppConsoleNoise: scheme-based classification must not be misled by message text', () => {
  it('keeps a real fetch-failure error from our own page even though its message text contains "http://" and "devtools://" substrings', () => {
    // The new classifier reads entry.url/entry.source, not entry.message. This
    // asserts that a business error mentioning noise-like substrings in its
    // message is still recognized as ours, because the url/source scheme says so.
    const result = isNonAppConsoleNoise(
      entry({
        message:
          'Uncaught (in promise) TypeError: Failed to fetch http://127.0.0.1:9000/api/x (see devtools:// for details)',
        url: 'file:///Volumes/jdisk/code/dimina-kit/packages/devtools/dist/renderer/entries/workbench/index.html',
        source: 'file:///Volumes/jdisk/code/dimina-kit/packages/devtools/dist/renderer/entries/workbench/index.html',
      }),
    )
    expect(result).toBe(false)
  })

  it('keeps a real app error whose url was truncated to 140 characters by the collector but still starts with file:', () => {
    // installConsoleCollector truncates url/source to 140 chars before this
    // function ever sees them. A deep enough path could, in principle, have
    // its leading "file:" pushed past a truncation boundary by a different
    // truncation strategy — this pins that the scheme must still be at index 0
    // after truncation for the entry to count as ours.
    const deepPath =
      `file:///Volumes/jdisk/code/dimina-kit/packages/devtools/dist/renderer/entries/workbench/very/deeply/nested/directory/structure/that/exceeds/one/hundred/and/forty/characters/index.html`
    const truncatedUrl = deepPath.slice(0, 140)
    expect(truncatedUrl.length).toBe(140)
    expect(truncatedUrl.startsWith('file:')).toBe(true)

    const result = isNonAppConsoleNoise(
      entry({
        message: 'Uncaught TypeError: Cannot read properties of undefined (reading \'bar\')',
        url: truncatedUrl,
        source: truncatedUrl,
      }),
    )
    expect(result).toBe(false)
  })
})
