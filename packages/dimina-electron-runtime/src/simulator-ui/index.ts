/**
 * The mini-app UI the runtime owns: the chrome every Dimina mini-app shows on
 * whatever it is installed into (navigation bar, capsule, tabBar) plus the page
 * stack and tabBar state machines behind them.
 *
 * Device emulation — bezel, notch, status bar, screen metrics — is NOT here: it
 * belongs to whatever host is pretending to be a phone.
 *
 * `getMenuCapsuleRect` re-exports through `./menu-capsule`; the geometry itself
 * lives in `shared/menu-button-geometry` so the React-free service host can
 * measure the capsule without pulling React in.
 *
 * The `css.d.ts` reference is what puts the CSS module declaration into a
 * consumer's type graph. Nothing imports that file, so a consumer building
 * from this entry would otherwise never load it and would see the components'
 * stylesheet imports as unresolved modules.
 */
// `css.d.ts` holds nothing but an ambient declaration, so there is no binding
// to import and no import that would pull it in — a reference directive is how
// a declaration-only file joins the program.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./css.d.ts" />
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
