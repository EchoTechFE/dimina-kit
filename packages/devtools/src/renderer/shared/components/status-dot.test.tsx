import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StatusDot } from './status-dot'

describe('StatusDot', () => {
  it('renders for ready status', () => {
    const { container } = render(<StatusDot status="ready" />)
    expect(container.querySelector('span')).toBeInTheDocument()
  })

  it('applies compiling styles', () => {
    const { container } = render(<StatusDot status="compiling" />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-status-warn')
  })

  it('applies error styles', () => {
    const { container } = render(<StatusDot status="error" />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-status-error')
  })

  it('applies ready styles', () => {
    const { container } = render(<StatusDot status="ready" />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-accent')
  })

  it('uses default for unknown status', () => {
    const { container } = render(<StatusDot status="unknown" />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-border')
  })
})
