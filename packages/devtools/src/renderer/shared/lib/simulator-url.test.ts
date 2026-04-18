import { describe, it, expect } from 'vitest'
import { buildSimulatorUrl, extractCurrentPage } from './simulator-url'

describe('buildSimulatorUrl', () => {
  it('builds URL with appId and startPage', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/index/index',
      scene: 1001,
      queryParams: [],
    }, 9000)
    expect(url).toContain('http://localhost:9000/simulator.html#wx123|pages/index/index')
    expect(url).toContain('scene=1001')
  })

  it('uses default startPage when empty', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: '',
      scene: 1001,
      queryParams: [],
    }, 9000)
    expect(url).toContain('|pages/index/index')
  })

  it('includes query params', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/detail/detail',
      scene: 1002,
      queryParams: [
        { key: 'id', value: '42' },
        { key: 'from', value: 'home' },
      ],
    }, 9000)
    expect(url).toContain('id=42')
    expect(url).toContain('from=home')
    expect(url).toContain('scene=1002')
  })

  it('filters empty query param keys', () => {
    const url = buildSimulatorUrl('wx123', {
      startPage: 'pages/index/index',
      scene: 1001,
      queryParams: [
        { key: '', value: 'ignored' },
        { key: 'valid', value: 'yes' },
      ],
    }, 9000)
    expect(url).not.toContain('ignored')
    expect(url).toContain('valid=yes')
  })
})

describe('extractCurrentPage', () => {
  it('extracts page path from hash', () => {
    const url = 'http://localhost:9000/#wx123/pages/index/index?scene=1001'
    expect(extractCurrentPage(url)).toBe('pages/index/index')
  })

  it('extracts nested path', () => {
    const url = 'http://localhost:9000/#wx123/subpackages/detail/detail'
    expect(extractCurrentPage(url)).toBe('subpackages/detail/detail')
  })

  it('returns empty string when no hash', () => {
    expect(extractCurrentPage('http://localhost:9000/')).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(extractCurrentPage('')).toBe('')
  })
})
