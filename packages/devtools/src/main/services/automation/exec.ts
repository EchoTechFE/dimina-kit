import type { WebContents } from 'electron'
import type { WorkbenchContext } from '../workbench-context.js'
import type { ElementRef } from './shared.js'

// ── Helpers ───────────────────────────────────────────────────────────

export function getSimulator(ctx: WorkbenchContext) {
  if (!ctx.workspace.hasActiveSession()) return null
  return ctx.views.getSimulatorWebContents()
}

export async function evalInSim<T = unknown>(ctx: WorkbenchContext, expression: string): Promise<T> {
  const sim = getSimulator(ctx)
  if (!sim) throw new Error('Simulator not connected')
  return sim.executeJavaScript(expression) as Promise<T>
}

/**
 * Native-host: the active page's DOM lives directly in the visible render-host
 * <webview> guest (no iframe), so element/page automation must run in that
 * WebContents' main world. Returns null on the default dimina-fe arch, where the
 * page lives inside an iframe of the simulator guest and automation goes through
 * `evalInSim` + `inIframe` instead.
 */
export function getActivePageWc(ctx: WorkbenchContext): WebContents | null {
  return ctx.bridge?.isNativeHost() ? ctx.bridge.getActiveRenderWc() : null
}

/**
 * Wrap guest code so `_doc` is the page document. Under native-host the render
 * guest IS the page document — no iframe lookup (cf. `inIframe`, which digs into
 * the simulator guest's last iframe). Mirrors `inIframe`'s `_doc` contract so the
 * same handler `body` strings work in both arches unchanged.
 */
export function wrapGuest(code: string): string {
  return `(() => { const _doc = document; return (function(){ ${code} })() })()`
}

/**
 * Run page-level automation code against the right document for the current arch:
 *   - native-host with a live active render guest → run in that guest's main
 *     world via `wrapGuest` (the guest IS the page document).
 *   - otherwise (default dimina-fe, or native-host with no active guest yet) →
 *     fall back to `evalInSim(inIframe(code))` (the existing simulator-iframe path).
 * The `code` is the same body either arch expects — it reads `_doc`.
 */
export async function evalInActivePage<T = unknown>(ctx: WorkbenchContext, code: string): Promise<T> {
  const renderWc = getActivePageWc(ctx)
  if (renderWc) {
    return renderWc.executeJavaScript(wrapGuest(code)) as Promise<T>
  }
  return evalInSim<T>(ctx, inIframe(code))
}

/** Build JS that locates an element by selector+index inside the active page document. */
export function buildElAccess(ref: ElementRef, varName = 'el'): string {
  return `const ${varName} = _doc.querySelectorAll(${JSON.stringify(ref.selector)})[${ref.index}]`
}

/** Run `body` inside the active page document with `varName` bound to the element at `ref`. */
export function evalInElement<T = unknown>(
  ctx: WorkbenchContext,
  ref: ElementRef,
  body: string,
  varName = 'el',
): Promise<T> {
  return evalInActivePage<T>(ctx, `${buildElAccess(ref, varName)}\n${body}`)
}

/** Wrap code to run inside the active page iframe (last iframe in the stack). */
export function inIframe(code: string): string {
  return `(() => {
    const iframes = document.querySelectorAll('iframe')
    const iframe = iframes[iframes.length - 1]
    if (!iframe || !iframe.contentDocument) throw new Error('No page iframe')
    const _doc = iframe.contentDocument
    return (function() { ${code} })()
  })()`
}
