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
import { AppDataPanel, type AppDataPanelState as AppDataState } from './appdata-panel-view.js'

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

  it('keeps the "not running" copy inside a kept-alive bridge container whose entries are empty', () => {
    // A host-built snapshot can carry a bridge with zero entries; the
    // per-bridge empty text must not claim "no page data yet" while the
    // session is actually down.
    const state: AppDataState = {
      bridges: [{ id: 'b1', pagePath: 'pages/index/index' }],
      activeBridgeId: 'b1',
      entries: { b1: {} },
    }
    const { getByTestId } = render(
      <AppDataPanel state={state} onSelectBridge={() => {}} isRuntimeRunning={false} />,
    )
    const text = getByTestId('appdata-panel').textContent ?? ''
    expect(
      text.includes('未运行'),
      `expected the per-bridge empty state to signal the session is not running; got: "${text}"`,
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
