import { describe, expect, it } from 'vitest'
import { resolveTagName } from './wxml-extract.js'
import type { ComponentInstance } from './wxml-extract.js'

function instance(type: Record<string, unknown>, extra: Record<string, unknown> = {}): ComponentInstance {
  return { type, ...extra } as ComponentInstance
}

describe('resolveTagName: authoritative Vue name = source path', () => {
  it('surfaces a custom component whose name is its full module path', () => {
    // The render runtime sets `name: componentPath` on every usingComponents
    // entry, so the panel tags the node with its source path (WeChat parity).
    expect(resolveTagName(instance({ name: '/components/ubt/index' }))).toBe('components/ubt/index')
  })

  it('surfaces a page whose name is its module path', () => {
    expect(resolveTagName(instance({ name: 'pages/tab/home/index' }))).toBe('pages/tab/home/index')
  })

  it('strips the leading slash so tags never start with `/`', () => {
    expect(resolveTagName(instance({ name: '/pages/index/index' }))).toBe('pages/index/index')
  })

  it('accepts the path off `__name` when `name` is absent', () => {
    expect(resolveTagName(instance({ __name: '/node-modules/pickpic/thumbnail/image' })))
      .toBe('node-modules/pickpic/thumbnail/image')
  })

  it('resolves from `type.name` alone, without any provides chain', () => {
    // Robustness over the legacy provide/inject reconstruction, which needed a
    // live parent provides chain; the per-type name carries the path directly.
    expect(resolveTagName(instance({ name: '/components/card/card' }, { parent: undefined, provides: undefined })))
      .toBe('components/card/card')
  })
})

describe('resolveTagName: non-path names keep the legacy fallback behavior', () => {
  it('kebab-cases a built-in PascalCase name (no slash → not a source path)', () => {
    expect(resolveTagName(instance({ name: 'ScrollView' }))).toBe('scroll-view')
  })

  it('does NOT mislabel a nameless `__scopeId` wrapper as a second page', () => {
    // A Taro template wrapper (`taro_tmpl`/`tmpl_0_3`) carries `__scopeId` but no
    // path-name and is not a page; it must fall back to `template`, never `page`.
    const wrapper = instance(
      { __scopeId: 'data-v-abc' },
      { parent: { type: { components: {} } }, appContext: { components: {} } },
    )
    expect(resolveTagName(wrapper)).not.toBe('page')
    expect(resolveTagName(wrapper)).toBe('template')
  })

  it('no longer reconstructs a path from the provides chain (heuristic removed)', () => {
    // Identity now comes solely from the authoritative `name`. An instance that
    // only carries the legacy signals (proxy.__page__ + provides.path, no
    // path-like name) is NOT upgraded to its path — it falls back like any
    // nameless __scopeId wrapper. Real pages/components always carry `name`.
    const legacy = instance(
      { __scopeId: 'data-v-x' },
      {
        proxy: { __page__: true },
        provides: { path: '/pages/legacy/legacy' },
        parent: { type: { components: {} } },
        appContext: { components: {} },
      },
    )
    expect(resolveTagName(legacy)).not.toBe('pages/legacy/legacy')
    expect(resolveTagName(legacy)).toBe('template')
  })
})
