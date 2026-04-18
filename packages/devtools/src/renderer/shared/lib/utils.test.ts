import { describe, it, expect } from 'vitest'
import { formatLastOpened, projectColor, cn } from './utils'

describe('formatLastOpened', () => {
  it('returns 从未打开 for null/undefined', () => {
    expect(formatLastOpened(null)).toBe('从未打开')
    expect(formatLastOpened(undefined)).toBe('从未打开')
  })

  it('returns 刚刚 for recent (< 1 min)', () => {
    const recent = new Date(Date.now() - 30_000).toISOString()
    expect(formatLastOpened(recent)).toBe('刚刚')
  })

  it('returns minutes ago for < 1 hour', () => {
    const mins = new Date(Date.now() - 90_000).toISOString()
    expect(formatLastOpened(mins)).toBe('1 分钟前')
  })

  it('returns hours ago for < 1 day', () => {
    const hours = new Date(Date.now() - 2 * 3_600_000).toISOString()
    expect(formatLastOpened(hours)).toBe('2 小时前')
  })

  it('returns locale date for older', () => {
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const result = formatLastOpened(old)
    expect(result).toMatch(/\d{4}\/\d{1,2}\/\d{1,2}/)
  })
})

describe('projectColor', () => {
  it('returns consistent color for same name', () => {
    const c1 = projectColor('my-project')
    const c2 = projectColor('my-project')
    expect(c1).toBe(c2)
  })

  it('returns different colors for different names', () => {
    const colors = new Set([
      projectColor('a'),
      projectColor('b'),
      projectColor('c'),
    ])
    expect(colors.size).toBeGreaterThan(1)
  })

  it('returns valid hex color', () => {
    const color = projectColor('test')
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
  })
})

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('handles conditional classes', () => {
    // eslint-disable-next-line no-constant-binary-expression
    expect(cn('base', false && 'hidden', true && 'visible')).toContain('visible')
  })

  it('handles tailwind merge (later overrides earlier)', () => {
    const result = cn('p-4', 'p-2')
    expect(result).toBe('p-2')
  })
})
