/**
 * The mini-app UI the runtime owns: `MiniAppFrame` — the whole running mini-app
 * (navigation bar, capsule, page stack, tabBar, native overlays) — plus the
 * state machines behind it and the `MiniAppHost` interface it reaches its
 * embedder through.
 *
 * Device emulation — bezel, notch, status bar, screen metrics — is NOT here: it
 * belongs to whatever host is pretending to be a phone.
 *
 * `getMenuCapsuleRect` re-exports through `./menu-capsule`; the geometry itself
 * lives in `shared/menu-button-geometry` so the React-free service host can
 * measure the capsule without pulling React in.
 *
 * This subpath ships as compiled JavaScript and declarations, so `css.d.ts` and
 * `webview.d.ts` serve this package's own compile only — both sit inside the
 * compiled directory and load with it. A consumer never sees them, and never
 * needs to: it resolves stylesheets through its own bundler and gets `<webview>`
 * already type-checked.
 */
export * from './miniapp-frame.js'
export * from './miniapp-host.js'
export * from './miniapp-routing.js'
export * from './ui-overlay.js'
export * from './ui-overlay-bus.js'
export * from './navigation-bar.js'
export * from './menu-capsule.js'
export * from './tab-bar.js'
export * from './tab-bar-state.js'
export * from './page-stack-controller.js'
export * from './navigate-home.js'
export {
  MENU_CAPSULE_HEIGHT,
  MENU_CAPSULE_TRAILING_SPACING,
  MENU_CAPSULE_WIDTH,
  getMenuCapsuleTopOffset,
  type MenuButtonRect,
  type MenuPlatform,
} from '../shared/menu-button-geometry.js'
