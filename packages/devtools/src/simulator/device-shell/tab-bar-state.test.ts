import { describe, it, expect } from 'vitest'
import {
  makeInitialTabBarState,
  applyTabAction,
} from './tab-bar-state'
import type { TabBarConfig } from '../../shared/bridge-channels'

// ---- helpers ----------------------------------------------------------------

function makeConfig(itemCount = 3): TabBarConfig {
  return {
    color: '#000000',
    selectedColor: '#1aad19',
    backgroundColor: '#ffffff',
    borderStyle: 'black',
    list: Array.from({ length: itemCount }, (_, i) => ({
      pagePath: `pages/p${i}/index`,
      text: `tab${i}`,
      iconPath: `static/p${i}.png`,
      selectedIconPath: `static/p${i}-active.png`,
    })),
  }
}

// ---- makeInitialTabBarState -------------------------------------------------

describe('makeInitialTabBarState', () => {
  it('returns hidden empty state when given null config (no tabBar configured)', () => {
    const s = makeInitialTabBarState(null)
    expect(s).toEqual({
      config: null,
      visible: false,
      badges: [],
      redDots: [],
    })
  })

  it('initialises visible=true and badges/redDots arrays sized to list length with default values', () => {
    const cfg = makeConfig(3)
    const s = makeInitialTabBarState(cfg)
    expect(s.config).toEqual(cfg)
    expect(s.visible).toBe(true)
    expect(s.badges).toEqual(['', '', ''])
    expect(s.redDots).toEqual([false, false, false])
  })

  it('handles a tabBar configured with an empty list (degenerate but legal config)', () => {
    const cfg: TabBarConfig = { list: [] }
    const s = makeInitialTabBarState(cfg)
    expect(s.config).toEqual(cfg)
    expect(s.visible).toBe(true)
    expect(s.badges).toEqual([])
    expect(s.redDots).toEqual([])
  })
})

// ---- reset ------------------------------------------------------------------

describe('applyTabAction — reset', () => {
  it('reset to null clears config and reports ok', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const res = applyTabAction(prev, { kind: 'reset', config: null })
    expect(res.ok).toBe(true)
    expect(res.state.config).toBeNull()
    expect(res.errMsg).toContain('ok')
  })

  it('reset to a new config rebuilds badges/redDots to the new list length', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const next = makeConfig(4)
    const res = applyTabAction(prev, { kind: 'reset', config: next })
    expect(res.ok).toBe(true)
    expect(res.state.config).toEqual(next)
    expect(res.state.badges).toEqual(['', '', '', ''])
    expect(res.state.redDots).toEqual([false, false, false, false])
  })
})

// ---- visibility -------------------------------------------------------------

describe('applyTabAction — visibility', () => {
  it('visibility=false produces hideTabBar:ok and flips visible to false', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const res = applyTabAction(prev, { kind: 'visibility', visible: false })
    expect(res.ok).toBe(true)
    expect(res.state.visible).toBe(false)
    expect(res.errMsg).toBe('hideTabBar:ok')
  })

  it('visibility=true produces showTabBar:ok and flips visible to true', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const hidden = applyTabAction(prev, { kind: 'visibility', visible: false }).state
    const res = applyTabAction(hidden, { kind: 'visibility', visible: true })
    expect(res.ok).toBe(true)
    expect(res.state.visible).toBe(true)
    expect(res.errMsg).toBe('showTabBar:ok')
  })
})

// ---- apply: missing config guard -------------------------------------------

describe('applyTabAction — apply guard when tabBar not configured', () => {
  it('rejects every API name with "fail tabBar not configured" when config is null', () => {
    const prev = makeInitialTabBarState(null)
    const names = [
      'setTabBarStyle',
      'setTabBarItem',
      'showTabBar',
      'hideTabBar',
      'setTabBarBadge',
      'removeTabBarBadge',
      'showTabBarRedDot',
      'hideTabBarRedDot',
    ] as const
    for (const name of names) {
      const res = applyTabAction(prev, { kind: 'apply', name, params: {} })
      expect(res.ok, `${name} should fail without config`).toBe(false)
      expect(res.errMsg).toContain('fail tabBar not configured')
    }
  })
})

// ---- setTabBarStyle ---------------------------------------------------------

describe('applyTabAction — setTabBarStyle', () => {
  it('writes color / selectedColor / backgroundColor / borderStyle into config when all valid', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarStyle',
      params: {
        color: '#abcdef',
        selectedColor: 'rgb(0,0,0)',
        backgroundColor: '#fff',
        borderStyle: 'white',
      },
    })
    expect(res.ok).toBe(true)
    expect(res.errMsg).toBe('setTabBarStyle:ok')
    expect(res.state.config?.color).toBe('#abcdef')
    expect(res.state.config?.selectedColor).toBe('rgb(0,0,0)')
    expect(res.state.config?.backgroundColor).toBe('#fff')
    expect(res.state.config?.borderStyle).toBe('white')
  })

  it('ignores borderStyle when value is not "black" or "white" (keeps the previous value)', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const before = prev.config!.borderStyle
    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarStyle',
      params: { borderStyle: 'rainbow' },
    })
    expect(res.state.config?.borderStyle).toBe(before)
  })

  it('rejects colour strings containing dangerous chars (script tags, quotes, semicolons, url())', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const originalColor = prev.config!.color
    const evilInputs = [
      '<script>alert(1)</script>',
      'red"; background: url(x)',
      "red';",
      'url(http://evil)',
    ]
    for (const evil of evilInputs) {
      const res = applyTabAction(prev, {
        kind: 'apply',
        name: 'setTabBarStyle',
        params: { color: evil },
      })
      expect(res.state.config?.color, `evil input rejected: ${evil}`).toBe(originalColor)
    }
  })

  it('accepts legal rgb / rgba / hsla colour forms', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const legal = ['rgb(10, 20, 30)', 'rgba(10,20,30,0.5)', 'hsla(120, 50%, 50%, 0.7)']
    for (const colour of legal) {
      const res = applyTabAction(prev, {
        kind: 'apply',
        name: 'setTabBarStyle',
        params: { color: colour },
      })
      expect(res.state.config?.color, `legal colour accepted: ${colour}`).toBe(colour)
    }
  })
})

// ---- setTabBarItem ----------------------------------------------------------

describe('applyTabAction — setTabBarItem', () => {
  it('updates a single text field without disturbing the other item fields', () => {
    const prev = makeInitialTabBarState(makeConfig(3))
    const original = prev.config!.list[0]
    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: 0, text: 'new' },
    })
    expect(res.ok).toBe(true)
    expect(res.state.config?.list[0].text).toBe('new')
    expect(res.state.config?.list[0].pagePath).toBe(original.pagePath)
    expect(res.state.config?.list[0].iconPath).toBe(original.iconPath)
    expect(res.state.config?.list[0].selectedIconPath).toBe(original.selectedIconPath)
  })

  it('updates iconPath and selectedIconPath independently', () => {
    const prev = makeInitialTabBarState(makeConfig(3))
    const res1 = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: 1, iconPath: 'static/new.png' },
    })
    expect(res1.state.config?.list[1].iconPath).toBe('static/new.png')

    const res2 = applyTabAction(res1.state, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: 1, selectedIconPath: 'static/new-active.png' },
    })
    expect(res2.state.config?.list[1].selectedIconPath).toBe('static/new-active.png')
    expect(res2.state.config?.list[1].iconPath).toBe('static/new.png')
  })

  it('returns ok:false with "invalid index" for out-of-range index', () => {
    const prev = makeInitialTabBarState(makeConfig(3))
    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: 99, text: 'x' },
    })
    expect(res.ok).toBe(false)
    expect(res.errMsg).toContain('invalid index')
  })

  it('returns ok:false on negative index', () => {
    const prev = makeInitialTabBarState(makeConfig(3))
    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: -1, text: 'x' },
    })
    expect(res.ok).toBe(false)
    expect(res.errMsg).toContain('invalid index')
  })

  it('returns ok:false on non-integer index (e.g. 1.5)', () => {
    const prev = makeInitialTabBarState(makeConfig(3))
    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: 1.5, text: 'x' },
    })
    expect(res.ok).toBe(false)
    expect(res.errMsg).toContain('invalid index')
  })
})

// ---- badges -----------------------------------------------------------------

describe('applyTabAction — badges', () => {
  it('setTabBarBadge writes text into badges[index] and clears the red dot at that slot', () => {
    const prev0 = makeInitialTabBarState(makeConfig(3))
    // first turn the red dot on
    const prev = applyTabAction(prev0, {
      kind: 'apply',
      name: 'showTabBarRedDot',
      params: { index: 0 },
    }).state

    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarBadge',
      params: { index: 0, text: '99+' },
    })
    expect(res.ok).toBe(true)
    expect(res.errMsg).toBe('setTabBarBadge:ok')
    expect(res.state.badges[0]).toBe('99+')
    expect(res.state.redDots[0]).toBe(false)
  })

  it('removeTabBarBadge resets badges[index] back to empty string', () => {
    const prev0 = makeInitialTabBarState(makeConfig(3))
    const withBadge = applyTabAction(prev0, {
      kind: 'apply',
      name: 'setTabBarBadge',
      params: { index: 0, text: 'N' },
    }).state
    const res = applyTabAction(withBadge, {
      kind: 'apply',
      name: 'removeTabBarBadge',
      params: { index: 0 },
    })
    expect(res.ok).toBe(true)
    expect(res.errMsg).toBe('removeTabBarBadge:ok')
    expect(res.state.badges[0]).toBe('')
  })

  it('badge operations reject out-of-range indices', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const r1 = applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarBadge',
      params: { index: 5, text: 'x' },
    })
    expect(r1.ok).toBe(false)
    expect(r1.errMsg).toContain('invalid index')

    const r2 = applyTabAction(prev, {
      kind: 'apply',
      name: 'removeTabBarBadge',
      params: { index: 5 },
    })
    expect(r2.ok).toBe(false)
    expect(r2.errMsg).toContain('invalid index')
  })
})

// ---- red dots ---------------------------------------------------------------

describe('applyTabAction — red dots', () => {
  it('showTabBarRedDot sets redDots[index]=true and clears badges[index]', () => {
    const prev0 = makeInitialTabBarState(makeConfig(3))
    const withBadge = applyTabAction(prev0, {
      kind: 'apply',
      name: 'setTabBarBadge',
      params: { index: 0, text: 'N' },
    }).state
    const res = applyTabAction(withBadge, {
      kind: 'apply',
      name: 'showTabBarRedDot',
      params: { index: 0 },
    })
    expect(res.ok).toBe(true)
    expect(res.errMsg).toBe('showTabBarRedDot:ok')
    expect(res.state.redDots[0]).toBe(true)
    expect(res.state.badges[0]).toBe('')
  })

  it('hideTabBarRedDot sets redDots[index]=false and does not touch badges', () => {
    const prev0 = makeInitialTabBarState(makeConfig(3))
    const shown = applyTabAction(prev0, {
      kind: 'apply',
      name: 'showTabBarRedDot',
      params: { index: 1 },
    }).state
    // pretend badge slot 1 has a value (simulate via setBadge, which would clear redDot,
    // so we instead just hide directly to test hideTabBarRedDot semantics)
    const res = applyTabAction(shown, {
      kind: 'apply',
      name: 'hideTabBarRedDot',
      params: { index: 1 },
    })
    expect(res.ok).toBe(true)
    expect(res.errMsg).toBe('hideTabBarRedDot:ok')
    expect(res.state.redDots[1]).toBe(false)
    // badges untouched at slot 1
    expect(res.state.badges[1]).toBe(shown.badges[1])
  })

  it('red-dot operations reject out-of-range indices', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const r1 = applyTabAction(prev, {
      kind: 'apply',
      name: 'showTabBarRedDot',
      params: { index: 5 },
    })
    expect(r1.ok).toBe(false)
    expect(r1.errMsg).toContain('invalid index')

    const r2 = applyTabAction(prev, {
      kind: 'apply',
      name: 'hideTabBarRedDot',
      params: { index: 5 },
    })
    expect(r2.ok).toBe(false)
    expect(r2.errMsg).toContain('invalid index')
  })
})

// ---- showTabBar / hideTabBar via apply --------------------------------------

describe('applyTabAction — showTabBar / hideTabBar via apply', () => {
  it('apply showTabBar reports showTabBar:ok and sets visible=true', () => {
    const prev0 = makeInitialTabBarState(makeConfig(2))
    const hidden = applyTabAction(prev0, { kind: 'visibility', visible: false }).state
    const res = applyTabAction(hidden, {
      kind: 'apply',
      name: 'showTabBar',
      params: {},
    })
    expect(res.ok).toBe(true)
    expect(res.errMsg).toBe('showTabBar:ok')
    expect(res.state.visible).toBe(true)
  })

  it('apply hideTabBar reports hideTabBar:ok and sets visible=false', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const res = applyTabAction(prev, {
      kind: 'apply',
      name: 'hideTabBar',
      params: {},
    })
    expect(res.ok).toBe(true)
    expect(res.errMsg).toBe('hideTabBar:ok')
    expect(res.state.visible).toBe(false)
  })
})

// ---- error message shape ----------------------------------------------------

describe('errMsg format convention', () => {
  it('every ok path errMsg has shape "<apiName>:ok"', () => {
    const cfg = makeConfig(2)
    const s = makeInitialTabBarState(cfg)
    const cases: Array<{ name: string; res: ReturnType<typeof applyTabAction> }> = [
      {
        name: 'setTabBarStyle',
        res: applyTabAction(s, {
          kind: 'apply',
          name: 'setTabBarStyle',
          params: { color: '#000' },
        }),
      },
      {
        name: 'setTabBarItem',
        res: applyTabAction(s, {
          kind: 'apply',
          name: 'setTabBarItem',
          params: { index: 0, text: 'a' },
        }),
      },
      {
        name: 'setTabBarBadge',
        res: applyTabAction(s, {
          kind: 'apply',
          name: 'setTabBarBadge',
          params: { index: 0, text: '1' },
        }),
      },
      {
        name: 'removeTabBarBadge',
        res: applyTabAction(s, {
          kind: 'apply',
          name: 'removeTabBarBadge',
          params: { index: 0 },
        }),
      },
      {
        name: 'showTabBarRedDot',
        res: applyTabAction(s, {
          kind: 'apply',
          name: 'showTabBarRedDot',
          params: { index: 0 },
        }),
      },
      {
        name: 'hideTabBarRedDot',
        res: applyTabAction(s, {
          kind: 'apply',
          name: 'hideTabBarRedDot',
          params: { index: 0 },
        }),
      },
    ]
    for (const c of cases) {
      expect(c.res.ok, `${c.name} should be ok`).toBe(true)
      expect(c.res.errMsg).toBe(`${c.name}:ok`)
    }
  })

  it('fail path errMsg starts with "<apiName>:fail "', () => {
    const s = makeInitialTabBarState(makeConfig(2))
    const r = applyTabAction(s, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: 99, text: 'x' },
    })
    expect(r.ok).toBe(false)
    expect(r.errMsg.startsWith('setTabBarItem:fail ')).toBe(true)
  })
})

// ---- immutability -----------------------------------------------------------

describe('applyTabAction — immutability', () => {
  it('does not mutate the previous state object (visibility transition)', () => {
    const prev = makeInitialTabBarState(makeConfig(2))
    const snapshot = JSON.parse(JSON.stringify(prev))
    const res = applyTabAction(prev, { kind: 'visibility', visible: false })
    expect(res.state).not.toBe(prev)
    expect(prev).toEqual(snapshot)
  })

  it('does not mutate the previous state when setTabBarBadge writes a new value', () => {
    const prev = makeInitialTabBarState(makeConfig(3))
    const snapshot = JSON.parse(JSON.stringify(prev))
    applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarBadge',
      params: { index: 0, text: '99+' },
    })
    expect(prev).toEqual(snapshot)
  })

  it('does not mutate the previous state when setTabBarItem rewrites a list entry', () => {
    const prev = makeInitialTabBarState(makeConfig(3))
    const snapshot = JSON.parse(JSON.stringify(prev))
    applyTabAction(prev, {
      kind: 'apply',
      name: 'setTabBarItem',
      params: { index: 0, text: 'new' },
    })
    expect(prev).toEqual(snapshot)
  })
})
