/**
 * The create card is always the first item in the project list,
 * even when `projects` is empty. The create card click must invoke the
 * `onCreate` callback the parent passed to the list (NOT `onAdd`, which
 * stays bound to the "导入" button).
 *
 * Bugs caught:
 *  - A regression that hides the create card while `projects.length === 0`
 *    leaves first-time users with an empty screen and no obvious next
 *    step. The spec says: always show.
 *  - A regression that mis-wires the create card to call `onAdd` would
 *    open the import directory picker instead of the new-project dialog.
 *  - A regression that places the create card at the END of the list
 *    forces the user to scroll past every existing project to scaffold
 *    a new one.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectList } from './project-list'

const MANY = Array.from({ length: 3 }, (_, i) => ({
  name: `P${i}`,
  path: `/p/${i}`,
  lastOpened: null,
}))

describe('ProjectList with create card', () => {
  it('renders the create card even when projects is empty (no empty-state)', () => {
    const onCreate = vi.fn()
    render(
      <ProjectList
        projects={[]}
        onAdd={() => {}}
        onCreate={onCreate}
        onOpen={() => {}}
        onRemove={() => {}}
      />,
    )
    expect(screen.getByText('新建项目')).toBeInTheDocument()
  })

  it('renders the create card as the first item BEFORE any existing project', () => {
    render(
      <ProjectList
        projects={MANY}
        onAdd={() => {}}
        onCreate={() => {}}
        onOpen={() => {}}
        onRemove={() => {}}
      />,
    )
    // Both the create-card label and the first project must be on the page.
    const create = screen.getByText('新建项目')
    const firstProject = screen.getByText('P0')
    expect(create).toBeInTheDocument()
    expect(firstProject).toBeInTheDocument()

    // DocumentPosition: create card precedes the first project. This
    // catches a regression that puts the card at the end of the grid.
    const cmp = create.compareDocumentPosition(firstProject)
    expect(cmp & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('clicking the create card calls onCreate, NOT onAdd', () => {
    const onCreate = vi.fn()
    const onAdd = vi.fn()
    render(
      <ProjectList
        projects={MANY}
        onAdd={onAdd}
        onCreate={onCreate}
        onOpen={() => {}}
        onRemove={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('新建项目'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('the 导入 button still calls onAdd (regression guard for the import path)', () => {
    const onAdd = vi.fn()
    render(
      <ProjectList
        projects={MANY}
        onAdd={onAdd}
        onCreate={() => {}}
        onOpen={() => {}}
        onRemove={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('导入'))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })
})
