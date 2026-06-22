/**
 * The "新建项目" card is rendered as the first item of the project
 * list. It must:
 *  - render a dashed-border placeholder card with a Chinese label,
 *  - invoke its `onClick` prop exactly once when the user clicks anywhere
 *    in the card.
 *
 * Bugs caught:
 *  - A refactor that drops the click handler leaves the user with no way
 *    to open the create dialog from the list view.
 *  - A refactor that swaps the visible label silently changes the UX
 *    affordance (e.g. shows English "New" or no text at all).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectCreateCard } from './project-create-card'

describe('ProjectCreateCard', () => {
  it('renders the Chinese label "新建项目"', () => {
    render(<ProjectCreateCard onClick={() => {}} />)
    expect(screen.getByText('新建项目')).toBeInTheDocument()
  })

  it('calls onClick when the card is clicked', () => {
    const onClick = vi.fn()
    render(<ProjectCreateCard onClick={onClick} />)
    fireEvent.click(screen.getByText('新建项目'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('exposes role="button" or keyboard affordance for accessibility', () => {
    render(<ProjectCreateCard onClick={() => {}} />)
    // Either a real <button>, or any element advertising role="button".
    const el =
      screen.queryByRole('button', { name: '新建项目' }) ??
      screen.queryByLabelText('新建项目')
    expect(el).not.toBeNull()
  })
})
