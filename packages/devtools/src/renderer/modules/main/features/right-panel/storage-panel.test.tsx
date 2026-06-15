/**
 * StoragePanel — appId-prefix stripping contract (TDD, written against the
 * public Props contract only, NOT the component internals).
 *
 * Pinned contract (the behavior this change introduces):
 *  - Storage keys are stored with an appId namespace prefix
 *    (e.g. `devtools_demo_001_token`). Like Chrome DevTools' Local Storage,
 *    the panel must DISPLAY the clean key with the prefix stripped (`token`),
 *    while every read/write operation still uses the FULL key.
 *  - The full key is preserved as a `title` attribute (hover-visible) so the
 *    user can still see the underlying namespaced key.
 *  - Keys that don't start with the prefix are shown verbatim.
 *  - The bare prefix is no longer rendered as a standalone visible label.
 *  - Delete / edit operations call onRemove / onSet with the FULL key.
 *
 * `getPrefix` is async, so the panel may first render with an empty prefix and
 * resolve the prefix afterward — prefix-dependent assertions wait via waitFor.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, waitFor, within } from '@testing-library/react'
import { StoragePanel } from './storage-panel'

const FULL_KEY = 'devtools_demo_001_token'
const PREFIX = 'devtools_demo_001_'

const okWrite = vi.fn(async () => ({ ok: true as const }))

function makeProps(overrides: Partial<Parameters<typeof StoragePanel>[0]> = {}) {
  return {
    items: [{ key: FULL_KEY, value: 'abc' }],
    onRefresh: vi.fn(),
    onSet: vi.fn(async () => ({ ok: true as const })),
    onRemove: vi.fn(async () => ({ ok: true as const })),
    onClear: vi.fn(async () => ({ ok: true as const })),
    onClearAll: vi.fn(async () => ({ ok: true as const })),
    getPrefix: vi.fn().mockResolvedValue(PREFIX),
    ...overrides,
  }
}

describe('StoragePanel: appId-prefix stripping', () => {
  it('displays the key with the appId prefix stripped, full key kept as title (Chrome-style)', async () => {
    const props = makeProps()
    const { container } = render(<StoragePanel {...props} />)

    // The element whose visible text is the clean key AND whose title carries
    // the full namespaced key only appears once the async prefix resolves.
    await waitFor(() => {
      const el = Array.from(container.querySelectorAll<HTMLElement>('[title]')).find(
        (node) => node.getAttribute('title') === FULL_KEY,
      )
      expect(
        el,
        'an element must expose the FULL key via title (hover) once getPrefix resolves',
      ).toBeTruthy()
      // The element (or a descendant) shows the stripped key as visible text…
      expect(el!.textContent).toContain('token')
      // …and NOT the full namespaced string.
      expect(el!.textContent).not.toContain(FULL_KEY)
    })
  })

  it('renders a non-prefixed key verbatim', async () => {
    const props = makeProps({ items: [{ key: 'sessionId', value: 'x' }] })
    const { findAllByText } = render(<StoragePanel {...props} />)

    // Wait for the prefix to resolve so we know stripping has been applied
    // (and would not have touched this key).
    await waitFor(() => expect(props.getPrefix).toHaveBeenCalled())
    const matches = await findAllByText('sessionId')
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('does not render the bare prefix as a standalone visible label', async () => {
    const props = makeProps()
    const { container } = render(<StoragePanel {...props} />)

    await waitFor(() => expect(props.getPrefix).toHaveBeenCalled())

    // The prefix may exist as a title attribute (allowed), but must not appear
    // as VISIBLE text anywhere in the panel.
    await waitFor(() => {
      const visible = Array.from(container.querySelectorAll<HTMLElement>('*')).some((node) => {
        // direct text nodes only — ignore aggregated descendant text and titles
        return Array.from(node.childNodes).some(
          (child) =>
            child.nodeType === Node.TEXT_NODE &&
            (child.textContent ?? '').includes(PREFIX),
        )
      })
      expect(
        visible,
        'the bare appId prefix must not be shown as visible text (title-only is fine)',
      ).toBe(false)
    })
  })

  it('delete uses the FULL key, not the stripped key', async () => {
    const onRemove = vi.fn(async () => ({ ok: true as const }))
    const props = makeProps({ onRemove })
    const { container } = render(<StoragePanel {...props} />)

    // Wait until the row reflects the resolved prefix (stripped key present).
    let removeBtn: HTMLElement | undefined
    await waitFor(() => {
      const titled = Array.from(container.querySelectorAll<HTMLElement>('[title]')).find(
        (node) => node.getAttribute('title') === FULL_KEY,
      )
      expect(titled).toBeTruthy()
      // Find the row containing the key, then its delete control. Walk up to the
      // smallest ancestor that also contains a delete control (handles tr/li/div
      // row layouts without assuming a specific tag).
      let row: HTMLElement = titled!.parentElement ?? container
      while (
        row !== container &&
        row.parentElement &&
        !Array.from(row.querySelectorAll('button')).some((b) => {
          const t = (b.getAttribute('title') ?? '') + (b.textContent ?? '')
          return t.includes('删除') || t.trim() === '×'
        })
      ) {
        row = row.parentElement
      }
      const btn = within(row as HTMLElement)
        .queryAllByRole('button')
        .find((b) => {
          const t = (b.getAttribute('title') ?? '') + (b.textContent ?? '')
          return t.includes('删除') || t.trim() === '×'
        })
      expect(btn, 'each row needs a delete control (title 含“删除” or text ×)').toBeTruthy()
      removeBtn = btn
    })

    fireEvent.click(removeBtn!)

    await waitFor(() => {
      expect(onRemove).toHaveBeenCalledTimes(1)
      expect(
        onRemove,
        'onRemove must receive the FULL namespaced key, not the stripped display key',
      ).toHaveBeenCalledWith(FULL_KEY)
    })
  })

  it('edit submits with the FULL key', async () => {
    const onSet = vi.fn(async (_key: string, _value: string) => ({ ok: true as const }))
    const props = makeProps({ onSet })
    const { container } = render(<StoragePanel {...props} />)

    await waitFor(() => {
      const titled = Array.from(container.querySelectorAll<HTMLElement>('[title]')).find(
        (node) => node.getAttribute('title') === FULL_KEY,
      )
      expect(titled).toBeTruthy()
    })

    // Enter edit mode by clicking the value cell (current value 'abc').
    const valueCell = Array.from(container.querySelectorAll<HTMLElement>('*')).find((node) =>
      Array.from(node.childNodes).some(
        (child) =>
          child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() === 'abc',
      ),
    )
    expect(valueCell, 'the value cell showing "abc" must be clickable to edit').toBeTruthy()
    fireEvent.click(valueCell!)

    // An editable input should now exist; change its value and submit with Enter.
    await waitFor(() => {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        'input, textarea',
      )
      expect(input, 'clicking the value cell must open an editable field').toBeTruthy()
    })
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    )!
    fireEvent.change(input, { target: { value: 'new-value' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(onSet).toHaveBeenCalled()
      expect(
        onSet.mock.calls[0][0],
        'onSet first arg must be the FULL namespaced key, not the stripped display key',
      ).toBe(FULL_KEY)
    })
  })
})
