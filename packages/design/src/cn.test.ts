import { describe, expect, it } from 'vitest'
import { cn } from './cn.js'

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy entries', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b')
  })

  it('lets the later Tailwind utility win within a group', () => {
    // This is the whole reason cn exists rather than a plain join: a caller's
    // override has to beat the component's default regardless of which one the
    // stylesheet happens to emit first.
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-text', 'text-text-muted')).toBe('text-text-muted')
  })

  it('keeps utilities from different groups', () => {
    expect(cn('p-2', 'text-sm')).toBe('p-2 text-sm')
  })
})
