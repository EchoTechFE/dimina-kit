/**
 * Contract: StoragePanel takes an `isRuntimeRunning?: boolean` prop (the
 * integration layer computes it as `runtimeStatus?.phase === 'running'`).
 * When the session is NOT running, an empty item list must render distinct
 * empty-state copy that says the session isn't running (must contain
 * "未运行" or "启动") — NOT the existing "暂无 Storage 数据" wording, which
 * would otherwise print even while the whole simulator is stuck on a launch
 * timeout or a crash and misleadingly imply "the app is fine, it just hasn't
 * written anything yet".
 *
 * Once running, the existing "暂无 Storage 数据" copy must be unchanged
 * (regression guard) — a running session with genuinely empty storage is a
 * completely different (normal) situation from a session that never got the
 * chance to run.
 *
 * Harness: props built directly against the component (StoragePanel takes no
 * context/provider).
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { StoragePanel } from '@dimina-kit/inspect/panel'

function makeProps(isRuntimeRunning: boolean): Parameters<typeof StoragePanel>[0] {
  return {
    items: [],
    onSet: vi.fn(async () => ({ ok: true as const })),
    onRemove: vi.fn(async () => ({ ok: true as const })),
    onClear: vi.fn(async () => ({ ok: true as const })),
    onClearAll: vi.fn(async () => ({ ok: true as const })),
    getPrefix: vi.fn().mockResolvedValue(''),
    isRuntimeRunning,
  }
}

describe('StoragePanel: empty-state copy reflects whether the session is actually running', () => {
  it('shows a "not running" empty state (contains 未运行 or 启动) when the session never reached running', () => {
    const { getByTestId } = render(<StoragePanel {...makeProps(false)} />)
    const text = getByTestId('storage-panel').textContent ?? ''
    expect(
      text.includes('未运行') || text.includes('启动'),
      `expected empty-state text to signal the session is not running; got: "${text}"`,
    ).toBe(true)
  })

  it('keeps the existing "暂无 Storage 数据" copy (unchanged) once running', () => {
    const { getByTestId, getByText } = render(<StoragePanel {...makeProps(true)} />)
    expect(getByText('暂无 Storage 数据')).toBeTruthy()
    const text = getByTestId('storage-panel').textContent ?? ''
    expect(
      text.includes('未运行'),
      'a genuinely-empty RUNNING session must not be painted with the "not running" copy',
    ).toBe(false)
  })

  it('does not show any empty-state copy when items are non-empty, regardless of runtime state', () => {
    const props = { ...makeProps(false), items: [{ key: 'k', value: 'v' }] }
    const { queryByText } = render(<StoragePanel {...props} />)
    expect(queryByText('暂无 Storage 数据')).toBeNull()
  })
})
