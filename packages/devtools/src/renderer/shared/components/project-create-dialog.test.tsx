/**
 * Phase 4 + suggestion-mode (5月 follow-up): the built-in "新建项目" dialog.
 *
 * GOALPOST CHANGE — was "name and directory are fully independent". After
 * user feedback the new contract is:
 *   - On open the path is suggested from `<defaultBaseDir>/<slug(name)>`.
 *   - Typing in the name keeps re-suggesting the path until the user
 *     manually edits the path or picks a directory via 浏览 — those acts
 *     "pin" the path and further name edits stop touching it.
 *
 * Contract:
 *  - Submit is disabled while name or path is empty/whitespace.
 *  - `onSubmit` receives { name, path, templateId } for the current selection.
 *  - 浏览 calls onBrowse and (if it returns a string) sets and pins the path.
 *
 * Bugs caught:
 *  - Suggestion stops following name once the user clearly opted out.
 *  - Picking a directory via 浏览 must also pin (regression check on the
 *    onBrowse path).
 *  - Empty / whitespace name still disables submit.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectCreateDialog, slugifyDirName } from './project-create-dialog'

const TEMPLATES = [
  { id: 'blank', name: 'Blank' },
  { id: 'taro-todo', name: 'Taro Todo' },
]

describe('ProjectCreateDialog', () => {
  it('renders both inputs (name + path) and the supplied templates', () => {
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={() => Promise.resolve(null)}
      />,
    )
    // Two distinct inputs — placeholders / labels are Chinese.
    expect(screen.getByLabelText(/项目名/)).toBeInTheDocument()
    expect(screen.getByLabelText(/目录|路径/)).toBeInTheDocument()
    // Both templates show up.
    expect(screen.getByText('Blank')).toBeInTheDocument()
    expect(screen.getByText('Taro Todo')).toBeInTheDocument()
  })

  it('suggests path = <defaultBaseDir>/<slug(name)> as the user types the name', () => {
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        defaultBaseDir="/Users/me/code"
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={() => Promise.resolve(null)}
      />,
    )
    const nameInput = screen.getByLabelText(/项目名/) as HTMLInputElement
    const pathInput = screen.getByLabelText(/目录|路径/) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'My Todo App' } })
    expect(pathInput.value).toBe('/Users/me/code/My-Todo-App')
    // Typing more keeps re-suggesting.
    fireEvent.change(nameInput, { target: { value: '我的小程序' } })
    expect(pathInput.value).toBe('/Users/me/code/我的小程序')
  })

  it('stops following the name once the user edits the path manually', () => {
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        defaultBaseDir="/Users/me/code"
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={() => Promise.resolve(null)}
      />,
    )
    const nameInput = screen.getByLabelText(/项目名/) as HTMLInputElement
    const pathInput = screen.getByLabelText(/目录|路径/) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'A' } })
    expect(pathInput.value).toBe('/Users/me/code/A')
    // User explicitly overrides the path — from here on it must stay put.
    fireEvent.change(pathInput, { target: { value: '/elsewhere/fixed' } })
    fireEvent.change(nameInput, { target: { value: 'totally-different' } })
    expect(pathInput.value).toBe('/elsewhere/fixed')
  })

  it('selecting a directory via 浏览 also pins the path against further name edits', async () => {
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        defaultBaseDir="/Users/me/code"
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={() => Promise.resolve('/picked/by/dialog')}
      />,
    )
    const nameInput = screen.getByLabelText(/项目名/) as HTMLInputElement
    const pathInput = screen.getByLabelText(/目录|路径/) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: /浏览|选择/ }))
    await new Promise((r) => setTimeout(r, 0))
    expect(pathInput.value).toBe('/picked/by/dialog')
    fireEvent.change(nameInput, { target: { value: 'B' } })
    expect(pathInput.value).toBe('/picked/by/dialog')
  })

  it('with no defaultBaseDir, suggestion is just the slug (user must point 浏览 at a real location)', () => {
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={() => Promise.resolve(null)}
      />,
    )
    fireEvent.change(screen.getByLabelText(/项目名/), {
      target: { value: 'My App' },
    })
    expect((screen.getByLabelText(/目录|路径/) as HTMLInputElement).value).toBe(
      'My-App',
    )
  })

  it('slugifyDirName strips unsafe characters and collapses separators', () => {
    expect(slugifyDirName('My / Bad : Name')).toBe('My-Bad-Name')
    expect(slugifyDirName('  spaced   out  ')).toBe('spaced-out')
    expect(slugifyDirName('我的 App')).toBe('我的-App')
    expect(slugifyDirName('a<b>c|d*e?f"g')).toBe('a-b-c-d-e-f-g')
    expect(slugifyDirName('')).toBe('')
  })

  it('disables submit when name or path is empty', () => {
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        // No defaultBaseDir → name suggests just the slug; clearing the
        // path manually below mimics the user wiping the suggestion.
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={() => Promise.resolve(null)}
      />,
    )
    const submit = screen.getByRole('button', {
      name: /创建|确定/,
    }) as HTMLButtonElement
    const nameInput = screen.getByLabelText(/项目名/) as HTMLInputElement
    const pathInput = screen.getByLabelText(/目录|路径/) as HTMLInputElement
    expect(submit.disabled).toBe(true)

    // Name alone with the path manually cleared → still disabled.
    fireEvent.change(nameInput, { target: { value: 'My App' } })
    fireEvent.change(pathInput, { target: { value: '' } })
    expect(submit.disabled).toBe(true)

    // Filling the path → enabled.
    fireEvent.change(pathInput, { target: { value: '/abs/target' } })
    expect(submit.disabled).toBe(false)

    // Whitespace-only name still disables.
    fireEvent.change(nameInput, { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
  })

  it('onSubmit receives { name, path, templateId } with the currently-selected template', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        onSubmit={onSubmit}
        onCancel={() => {}}
        onBrowse={() => Promise.resolve(null)}
      />,
    )
    fireEvent.change(screen.getByLabelText(/项目名/), {
      target: { value: 'My App' },
    })
    fireEvent.change(screen.getByLabelText(/目录|路径/), {
      target: { value: '/abs/target' },
    })
    // Pick the second template.
    fireEvent.click(screen.getByText('Taro Todo'))
    fireEvent.click(screen.getByRole('button', { name: /创建|确定/ }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'My App',
      path: '/abs/target',
      templateId: 'taro-todo',
    })
  })

  it('clicking 浏览 calls onBrowse and fills the path with the returned value', async () => {
    const onBrowse = vi.fn(() => Promise.resolve('/picked/path'))
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={onBrowse}
      />,
    )
    const browse = screen.getByRole('button', { name: /浏览|选择/ })
    fireEvent.click(browse)
    // Allow the promise to resolve and the component to re-render.
    await new Promise((r) => setTimeout(r, 0))
    expect(onBrowse).toHaveBeenCalledTimes(1)
    const pathInput = screen.getByLabelText(/目录|路径/) as HTMLInputElement
    expect(pathInput.value).toBe('/picked/path')
  })

  it('clicking 浏览 then cancelling (onBrowse → null) leaves the path unchanged', async () => {
    const onBrowse = vi.fn(() => Promise.resolve(null))
    render(
      <ProjectCreateDialog
        open
        templates={TEMPLATES}
        onSubmit={() => {}}
        onCancel={() => {}}
        onBrowse={onBrowse}
      />,
    )
    fireEvent.change(screen.getByLabelText(/目录|路径/), {
      target: { value: '/preexisting' },
    })
    fireEvent.click(screen.getByRole('button', { name: /浏览|选择/ }))
    await new Promise((r) => setTimeout(r, 0))
    const pathInput = screen.getByLabelText(/目录|路径/) as HTMLInputElement
    expect(pathInput.value).toBe('/preexisting')
  })
})
