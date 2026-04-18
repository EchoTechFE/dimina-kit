/**
 * dimina-automator — automation SDK for mini program testing.
 *
 * API design mirrors WeChat miniprogram-automator:
 *   Automator.launch() → MiniProgram → Page → Element
 *
 * Built on top of Playwright Electron + existing e2e helpers.
 */

export { Automator } from './automator'
export { MiniProgram } from './mini-program'
export { Page } from './page'
export { Element } from './element'
export type { AutomatorLaunchOptions } from './automator'
