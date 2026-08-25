/**
 * Regression: main.tsx used to `.finally()` its placement-generation seed
 * IPC call, so a rejected `ensurePlacementGenerationSeeded()` (main never
 * answered the seed request — see renderer-placement-generation.ts's header
 * for the boot-order race that can cause this) still mounted the app,
 * silently proceeding on an un-seeded generation counter that would collide
 * with main's high-water mark. The fix branches on success/failure — the
 * app must only mount once a real, main-issued seed is in hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const seedModule = vi.hoisted(() => ({
  ensurePlacementGenerationSeeded: vi.fn(() => Promise.resolve()),
}))

const reactDom = vi.hoisted(() => ({
  render: vi.fn(),
  createRoot: vi.fn(),
}))
reactDom.createRoot.mockImplementation(() => ({ render: reactDom.render }))

vi.mock('../../shared/renderer-placement-generation.js', () => seedModule)
vi.mock('react-dom/client', () => ({ default: { createRoot: reactDom.createRoot } }))
vi.mock('../../design.css', () => ({}))
vi.mock('../../modules/main/main', () => ({ default: () => null }))

beforeEach(() => {
  vi.resetModules()
  seedModule.ensurePlacementGenerationSeeded.mockReset()
  reactDom.createRoot.mockClear()
  reactDom.render.mockClear()
  document.body.innerHTML = '<div id="root"></div>'
})

describe('main.tsx: gates the first render on the placement-generation seed', () => {
  it('mounts the app once the seed resolves', async () => {
    seedModule.ensurePlacementGenerationSeeded.mockResolvedValue(undefined)

    await import('./main.js')
    await Promise.resolve() // let the .then() microtask run

    expect(reactDom.createRoot).toHaveBeenCalledTimes(1)
    expect(reactDom.render).toHaveBeenCalledTimes(1)
  })

  it('does NOT mount the app when the seed allocation rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    seedModule.ensurePlacementGenerationSeeded.mockRejectedValue(
      new Error('failed to allocate a generation seed from main'),
    )

    await import('./main.js')
    await Promise.resolve()
    await Promise.resolve() // let the .catch() microtask run

    expect(reactDom.createRoot).not.toHaveBeenCalled()
    expect(reactDom.render).not.toHaveBeenCalled()
    expect(document.getElementById('root')?.textContent).toMatch(/failed to start/i)
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })
})
