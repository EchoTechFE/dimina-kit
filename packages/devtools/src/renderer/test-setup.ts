import { expect, vi } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'

expect.extend(matchers)

// jsdom does not implement Element.prototype.scrollIntoView; components that
// auto-scroll (e.g. the compile panel) call it during effects.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
