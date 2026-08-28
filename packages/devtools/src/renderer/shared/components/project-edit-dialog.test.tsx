/**
 * The project-edit dialog's contract with its caller.
 *
 * The directory field is the one that must NOT be editable: it identifies the
 * record and keys every other per-project store, so a dialog that let it
 * through would orphan the compile config and thumbnail of the project it
 * "edited". The other assertions cover the two ways a dialog silently loses
 * or leaks an edit: not re-seeding when it reopens on another card, and
 * submitting a blank name.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectEditDialog } from './project-edit-dialog'
import type { Project } from '../types'

const alpha: Project = {
  name: 'Alpha',
  path: '/path/alpha',
  lastOpened: null,
  iconUrl: 'https://cdn.example.com/a.png',
}
const beta: Project = { name: 'Beta', path: '/path/beta', lastOpened: null }

function nameInput() {
  return screen.getByLabelText('项目名称') as HTMLInputElement
}
function iconInput() {
  return screen.getByLabelText('图标地址') as HTMLInputElement
}
function pathInput() {
  return screen.getByLabelText('项目目录') as HTMLInputElement
}

describe('ProjectEditDialog', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <ProjectEditDialog
        open={false}
        project={alpha}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('编辑项目')).not.toBeInTheDocument()
  })

  it('seeds both editable fields from the project', () => {
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(nameInput().value).toBe('Alpha')
    expect(iconInput().value).toBe('https://cdn.example.com/a.png')
    expect(pathInput().value).toBe('/path/alpha')
  })

  it('shows the directory but does not let the user change it', () => {
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(pathInput()).toBeDisabled()
    expect(pathInput().readOnly).toBe(true)
  })

  it('submits a trimmed patch of the editable fields only', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.change(nameInput(), { target: { value: '  改名后  ' } })
    fireEvent.change(iconInput(), { target: { value: ' https://cdn.example.com/b.png ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledWith({
      name: '改名后',
      iconUrl: 'https://cdn.example.com/b.png',
    })
  })

  it('submits an empty iconUrl so the card falls back to the name initial', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.change(iconInput(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    // name is untouched, so it is left out of the patch — only the field
    // the user actually changed goes out.
    expect(onSubmit).toHaveBeenCalledWith({ iconUrl: '' })
  })

  it('blocks saving a blank name', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.change(nameInput(), { target: { value: '   ' } })
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('omits name from the patch when only the icon changed', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    // nameInput is seeded with 'Alpha' (project.name) — leave it untouched.
    fireEvent.change(iconInput(), { target: { value: 'https://cdn.example.com/c.png' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledWith({ iconUrl: 'https://cdn.example.com/c.png' })
    expect('name' in onSubmit.mock.calls[0][0]).toBe(false)
  })

  it('submits an empty patch when nothing changed', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledWith({})
  })

  it('does not submit on Enter while an IME composition is in progress, but does once it ends', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    const input = nameInput()
    // fireEvent.keyDown's event-init argument does not reliably surface as
    // e.nativeEvent.isComposing (React reads the property off the native
    // event, and testing-library's synthetic init does not always forward
    // it) — dispatch a real KeyboardEvent so the guard reads the same
    // property production code reads.
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
    )
    expect(onSubmit).not.toHaveBeenCalled()

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: false, bubbles: true, cancelable: true }),
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('shows the submit error and disables saving while a submit is in flight', () => {
    render(
      <ProjectEditDialog
        open
        project={alpha}
        error="当前宿主不支持编辑项目"
        submitting
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText('当前宿主不支持编辑项目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('re-seeds when it reopens on a different project', () => {
    const { rerender } = render(
      <ProjectEditDialog
        open
        project={alpha}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    fireEvent.change(nameInput(), { target: { value: 'edited but cancelled' } })

    rerender(
      <ProjectEditDialog
        open
        project={beta}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(nameInput().value).toBe('Beta')
    expect(iconInput().value).toBe('')
    expect(pathInput().value).toBe('/path/beta')
  })
})
