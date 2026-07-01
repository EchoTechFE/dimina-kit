import { expect, vi } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'

expect.extend(matchers)

// jsdom does not implement scrollIntoView; stub it so components that call it
// during effects do not throw "scrollIntoView is not a function".
Element.prototype.scrollIntoView = vi.fn()
