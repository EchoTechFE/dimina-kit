import { describe, expect, it } from 'vitest'
import { createSimulatorApiRegistry } from './custom-apis.js'

describe('SimulatorApiRegistry.register name validation', () => {
  it('rejects a name containing a comma', () => {
    const registry = createSimulatorApiRegistry()
    expect(() => registry.register('foo,bar', () => undefined)).toThrow(/comma/)
  })

  it('rejects a name containing whitespace', () => {
    const registry = createSimulatorApiRegistry()
    expect(() => registry.register('foo bar', () => undefined)).toThrow(/whitespace/)
    expect(() => registry.register(' foo', () => undefined)).toThrow(/whitespace/)
    expect(() => registry.register('foo ', () => undefined)).toThrow(/whitespace/)
  })

  it('rejects an empty name', () => {
    const registry = createSimulatorApiRegistry()
    expect(() => registry.register('', () => undefined)).toThrow()
  })

  it('accepts a normal name and round-trips through list/has/invoke', async () => {
    const registry = createSimulatorApiRegistry()
    registry.register('joinIsland', async params => ({ echo: params }))
    expect(registry.list()).toEqual(['joinIsland'])
    expect(registry.has('joinIsland')).toBe(true)
    await expect(registry.invoke('joinIsland', { a: 1 })).resolves.toEqual({ echo: { a: 1 } })
  })

  it('passes invocation context separately from untrusted miniapp parameters', async () => {
    const registry = createSimulatorApiRegistry()
    registry.register('login', async (_params, context) => context?.projectPath)
    await expect(registry.invoke('login', { projectPath: '/forged' }, { projectPath: '/actual' }))
      .resolves.toBe('/actual')
  })
})
