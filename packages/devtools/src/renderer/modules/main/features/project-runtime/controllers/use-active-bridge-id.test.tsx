/**
 * Unit tests for `useActiveBridgeId`.
 *
 * Validates the synchronous-derivation contract:
 * - `activeBridgeId` must be correct on the **same render** as `bridges`
 *   changes — no useEffect lag allowed.
 * - Tracks the last newly-added bridge id automatically.
 * - Manual selection via `setActiveBridge` is respected across rerenders
 *   (while no new bridge id appears).
 * - A newly-added bridge always overrides a prior manual selection.
 * - If the selected bridge id is removed, falls back to the last bridge.
 * - Calling `setActiveBridge` with an id not in `bridges` is ignored.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// This import will fail until the implementing agent creates the file —
// that is the intended red state.
import { useActiveBridgeId } from './use-active-bridge-id'

const A = { id: 'A', pagePath: '/a' }
const B = { id: 'B', pagePath: '/b' }
const C = { id: 'C', pagePath: '/c' }

describe('useActiveBridgeId — synchronous derivation contract', () => {
  // Step 1: initial empty bridges → activeBridgeId is null
  it('step 1: returns null when bridges is empty', () => {
    const { result } = renderHook(() => useActiveBridgeId([]))
    // Must be correct synchronously — no await / flush needed
    expect(result.current.activeBridgeId).toBeNull()
  })

  // Step 2: first bridge appears → activeBridgeId follows immediately
  it('step 2: tracks the only bridge synchronously on rerender', () => {
    const { result, rerender } = renderHook(
      ({ bridges }) => useActiveBridgeId(bridges),
      { initialProps: { bridges: [] as typeof A[] } },
    )
    expect(result.current.activeBridgeId).toBeNull()

    rerender({ bridges: [A] })
    // Synchronous check — if the impl uses useEffect, this will still be null → red
    expect(result.current.activeBridgeId).toBe('A')
  })

  // Step 3: new bridge B is appended → activeBridgeId follows the newest (last) id
  it('step 3: follows the newest bridge when a new id is added', () => {
    const { result, rerender } = renderHook(
      ({ bridges }) => useActiveBridgeId(bridges),
      { initialProps: { bridges: [] as Array<{ id: string; pagePath: string | null }> } },
    )

    rerender({ bridges: [A] })
    expect(result.current.activeBridgeId).toBe('A')

    rerender({ bridges: [A, B] })
    // B is new — must be selected synchronously
    expect(result.current.activeBridgeId).toBe('B')
  })

  // Step 4 + 5: manual setActiveBridge is respected and persists across rerenders
  // without new bridge ids
  it('step 4+5: setActiveBridge selects a valid id and persists across rerenders with no new bridges', () => {
    const { result, rerender } = renderHook(
      ({ bridges }) => useActiveBridgeId(bridges),
      { initialProps: { bridges: [A, B] } },
    )
    // After initial render with [A, B], B is last → selected
    expect(result.current.activeBridgeId).toBe('B')

    // Step 4: manual select A
    act(() => {
      result.current.setActiveBridge('A')
    })
    expect(result.current.activeBridgeId).toBe('A')

    // Step 5: rerender with the same ids — no new bridge → manual selection persists
    rerender({ bridges: [A, B] })
    expect(result.current.activeBridgeId).toBe('A')
  })

  // Step 6: selected bridge is removed → falls back to last bridge
  it('step 6: falls back to last bridge when the selected bridge is removed', () => {
    const { result, rerender } = renderHook(
      ({ bridges }) => useActiveBridgeId(bridges),
      { initialProps: { bridges: [A, B] } },
    )

    // Manually select A
    act(() => {
      result.current.setActiveBridge('A')
    })
    expect(result.current.activeBridgeId).toBe('A')

    // Remove A — only B remains
    rerender({ bridges: [B] })
    expect(result.current.activeBridgeId).toBe('B')
  })

  // Step 7: new bridge C appears even when A was manually selected → C takes over
  it('step 7: new bridge overrides prior manual selection synchronously', () => {
    const { result, rerender } = renderHook(
      ({ bridges }) => useActiveBridgeId(bridges),
      { initialProps: { bridges: [A, B] } },
    )

    // Manual select A
    act(() => {
      result.current.setActiveBridge('A')
    })
    expect(result.current.activeBridgeId).toBe('A')

    // C is a newly-added bridge id → must override manual selection
    rerender({ bridges: [A, B, C] })
    // Synchronous check — C must be selected in this render, not a future one
    expect(result.current.activeBridgeId).toBe('C')
  })

  // Extra: setActiveBridge with unknown id is silently ignored
  it('ignores setActiveBridge calls with an id not present in bridges', () => {
    const { result } = renderHook(() => useActiveBridgeId([A, B]))
    // Default: B (last)
    expect(result.current.activeBridgeId).toBe('B')

    act(() => {
      result.current.setActiveBridge('DOES_NOT_EXIST')
    })
    // Still B — invalid id was ignored
    expect(result.current.activeBridgeId).toBe('B')
  })
})
