/**
 * Contract: AppDataPanel takes an `isRuntimeRunning?: boolean` prop (the
 * integration layer computes it as `runtimeStatus?.phase === 'running'`).
 * When the session is NOT running, the empty state must render distinct copy
 * that says the session isn't running (must contain "未运行" or "启动") —
 * NOT the existing "暂无页面数据" wording, which would otherwise print even
 * while the simulator is stuck on a launch failure or a crash and
 * misleadingly imply "the app is fine, it just has no page data yet".
 *
 * Once running, the existing "暂无页面数据（仅显示 Page 级 data）" copy must
 * be unchanged (regression guard).
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AppDataPanel } from './appdata-panel'
import type { AppDataState } from '../project-runtime/controllers/use-panel-data'

const EMPTY_STATE: AppDataState = { bridges: [], activeBridgeId: null, entries: {} }

function makeProps(isRuntimeRunning: boolean): Parameters<typeof AppDataPanel>[0] {
  return {
    state: EMPTY_STATE,
    onSelectBridge: () => {},
    isRuntimeRunning,
  }
}

describe('AppDataPanel: empty-state copy reflects whether the session is actually running', () => {
  it('shows a "not running" empty state (contains 未运行 or 启动) when the session never reached running', () => {
    const { getByTestId } = render(<AppDataPanel {...makeProps(false)} />)
    const text = getByTestId('appdata-panel').textContent ?? ''
    expect(
      text.includes('未运行') || text.includes('启动'),
      `expected empty-state text to signal the session is not running; got: "${text}"`,
    ).toBe(true)
  })

  it('keeps the existing "暂无页面数据" copy (unchanged) once running', () => {
    const { getByTestId, getByText } = render(<AppDataPanel {...makeProps(true)} />)
    expect(getByText('暂无页面数据（仅显示 Page 级 data）')).toBeTruthy()
    const text = getByTestId('appdata-panel').textContent ?? ''
    expect(
      text.includes('未运行'),
      'a genuinely-empty RUNNING session must not be painted with the "not running" copy',
    ).toBe(false)
  })
})
