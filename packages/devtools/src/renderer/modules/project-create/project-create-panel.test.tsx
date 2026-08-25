/**
 * Regression: `ProjectCreateDialog` only clears its internal 项目名/目录
 * fields on an `[open]` transition (see project-create-dialog.tsx), but this
 * panel always passes a literal `open` — the prop never toggles, so that
 * reset effect only ever fires on the panel's first mount. Cancelling (or
 * submitting) an in-flight create must therefore drop `request` back to
 * null, which unmounts `ProjectCreateDialog` — the only way a subsequent
 * `showProjectCreateDialog()` for a DIFFERENT session gets a fresh instance
 * instead of one still carrying the previous session's typed name/path.
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { onProjectCreateInitMock, notifyOverlayReadyMock, submitProjectCreateMock, cancelProjectCreateMock, initHandlers } = vi.hoisted(() => {
  const initHandlers: Array<(payload: unknown) => void> = []
  return {
    onProjectCreateInitMock: vi.fn((handler: (payload: unknown) => void) => {
      initHandlers.push(handler)
      return () => {
        const idx = initHandlers.indexOf(handler)
        if (idx >= 0) initHandlers.splice(idx, 1)
      }
    }),
    notifyOverlayReadyMock: vi.fn(),
    submitProjectCreateMock: vi.fn(),
    cancelProjectCreateMock: vi.fn(),
    initHandlers,
  }
})

vi.mock('@/shared/api', () => ({
  notifyOverlayReady: notifyOverlayReadyMock,
  onProjectCreateInit: onProjectCreateInitMock,
  submitProjectCreate: submitProjectCreateMock,
  cancelProjectCreate: cancelProjectCreateMock,
  chooseProjectDirectory: vi.fn(async () => null),
}))

import ProjectCreatePanel from './project-create-panel'

const PAYLOAD_A = { templates: [{ id: 'blank', name: 'Blank' }], defaultBaseDir: '/projects' }
const PAYLOAD_B = { templates: [{ id: 'blank', name: 'Blank' }], defaultBaseDir: '/other' }

beforeEach(() => {
  initHandlers.length = 0
  notifyOverlayReadyMock.mockClear()
  submitProjectCreateMock.mockClear()
  cancelProjectCreateMock.mockClear()
})

function fireInit(payload: unknown) {
  act(() => { for (const h of [...initHandlers]) h(payload) })
}

describe('ProjectCreatePanel: cancel/reopen does not leak the previous session\'s typed input', () => {
  it('cancelling clears the typed 项目名 before the next show renders', async () => {
    render(<ProjectCreatePanel />)
    fireInit(PAYLOAD_A)

    fireEvent.change(await screen.findByLabelText('项目名'), { target: { value: 'ProjectA' } })
    expect(screen.getByLabelText('项目名')).toHaveValue('ProjectA')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(cancelProjectCreateMock).toHaveBeenCalledTimes(1)

    fireInit(PAYLOAD_B)

    expect(await screen.findByLabelText('项目名')).toHaveValue('')
  })

  it('submitting also clears the typed 项目名 before the next show renders', async () => {
    render(<ProjectCreatePanel />)
    fireInit(PAYLOAD_A)

    fireEvent.change(await screen.findByLabelText('项目名'), { target: { value: 'ProjectA' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并打开' }))
    expect(submitProjectCreateMock).toHaveBeenCalledTimes(1)

    fireInit(PAYLOAD_B)

    expect(await screen.findByLabelText('项目名')).toHaveValue('')
  })
})
