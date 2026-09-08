/** One collected console entry from `installConsoleCollector`. */
export interface ConsoleErrorEntry {
  level: 'error' | 'warning'
  message: string
  url: string
  source: string
}

/**
 * Which of the three surfaces a console entry came from.
 *
 * `installConsoleCollector` attaches to EVERY WebContents, so its entries mix
 * three unrelated products: our own app, the embedded A2 workbench (a
 * third-party VS Code bundle we merely host, served over a 127.0.0.1 COI
 * origin) and Chromium's own DevTools front-end (`devtools://`). Only the
 * first can be evidence that a gesture under test broke something.
 */
export type ConsoleSurface = 'app' | 'workbench' | 'devtools'

/**
 * Decide whose page an entry came from, from the URL scheme alone.
 *
 * The scheme is the authoritative answer and the reason this is not keyword
 * matching: our own bundle is loaded from `file://…/packages/devtools/…`, so
 * any rule keyed on the product name "devtools" appearing SOMEWHERE in the
 * entry classifies our own errors as someone else's and silently empties the
 * assertions that depend on it. A scheme also survives `installConsoleCollector`
 * truncating url/source to 140 characters, because it sits at the front.
 *
 * `url` is the page; `source` is the script. A worker or an iframe can report
 * an empty page url, so fall back to the script. When neither says anything,
 * the entry counts as ours — an unattributable error should fail a test, not
 * disappear from it.
 */
export function classifyConsoleSurface(entry: Pick<ConsoleErrorEntry, 'url' | 'source'>): ConsoleSurface {
  const origin = entry.url || entry.source
  if (/^devtools:/i.test(origin)) return 'devtools'
  if (/^https?:/i.test(origin)) return 'workbench'
  return 'app'
}

/**
 * Whether a collected console entry is something other than a real error from
 * our own renderer, and so cannot be evidence that a gesture under test broke
 * the app.
 *
 * Single owner on purpose: every "no unexpected console errors" assertion has
 * to agree on what counts as ours.
 *
 * Lives in its own module, free of Electron and Playwright imports, so these
 * rules can be unit-tested directly. A filter that quietly swallows real app
 * errors turns every caller's assertion into a no-op without failing anything,
 * which no end-to-end run can detect.
 */
export function isNonAppConsoleNoise(entry: ConsoleErrorEntry): boolean {
  if (classifyConsoleSurface(entry) !== 'app') return true

  // Chromium writes these about our page rather than from it: a failed
  // subresource load and a missing source map are not JS errors and no
  // gesture under test can cause them. Matched on the message alone —
  // matching them against url/source is what lets a path substring stand in
  // for an actual diagnosis.
  if (/net::ERR|Failed to load resource|DevTools failed to load source ?map/i.test(entry.message)) return true

  // The A2 workbench's startup chatter is normally attributed to its own
  // 127.0.0.1 origin and already handled above. These two arrive with no
  // origin at all, so the message text is the only thing left to key on.
  if (/json\.schemas is not a registered configuration|Unable to resolve nonexistent file '\/workspace'/i.test(entry.message)) return true

  return false
}
