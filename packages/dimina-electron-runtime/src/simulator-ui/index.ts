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
 * The `css.d.ts` and `webview.d.ts` references are what put those ambient
 * declarations into a consumer's type graph. Nothing imports either file, so a
 * consumer building from this entry would otherwise never load them and would
 * see the components' stylesheet imports as unresolved modules and `<webview>`
 * as an unknown element.
 */
// These hold nothing but ambient declarations, so there is no binding to import
// and no import that would pull them in — a reference directive is how a
// declaration-only file joins the program.
/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="./css.d.ts" />
/// <reference path="./webview.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */
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
