import { describe, it, expect } from 'vitest'

// Pins the pure helpers `selectSimulatorTarget` / `setNativeHost` / `setActiveBridgeId`
// exported by target-manager.ts.
//
// `target-manager.ts` 在模块顶层 import 了 `chrome-remote-interface`(CDP)，
// vitest 下加载它不会真正建立连接，所以可以直接静态 import 这些纯函数/setter。
import {
  selectSimulatorTarget,
  setNativeHost,
  setActiveBridgeId,
} from './target-manager.js'

type Target = { url?: string; type?: string }

// 真实形态的 target 列表片段，复用于多条规则。
const shell: Target = { type: 'page', url: 'http://localhost:7788/simulator.html' }
const workbench: Target = { type: 'page', url: 'file:///app/dist/entries/main/index.html' }
const guestB1: Target = {
  type: 'webview',
  url: 'file:///app/dist/render-host/pageFrame.html?appId=x&bridgeId=b1',
}
const guestB2: Target = {
  type: 'webview',
  url: 'file:///app/dist/render-host/pageFrame.html?appId=x&bridgeId=b2',
}
const noUrl: Target = { type: 'other' } // 故意缺 url，用于验证跳过不抛错

describe('selectSimulatorTarget — 双形态 simulator target 解析', () => {
  // 规则 1: 非 native-host —— 退化成今天的行为，挑第一个含 localhost:7788 的 target，activeBridgeId 被忽略。
  it('规则1: nativeHost=false 返回首个 localhost:7788 shell；activeBridgeId 被忽略', () => {
    const targets = [workbench, guestB1, shell, guestB2]
    const picked = selectSimulatorTarget(targets, { nativeHost: false, activeBridgeId: 'b2' })
    expect(picked).toBe(shell)
  })

  // 规则 1 边界: 非 native-host 且没有 7788 shell —— 返回 undefined（即使存在 pageFrame guest 也不挑）。
  it('规则1边界: nativeHost=false 且无 7788 shell 返回 undefined（不退回 pageFrame guest）', () => {
    const targets = [workbench, guestB1, guestB2]
    const picked = selectSimulatorTarget(targets, { nativeHost: false, activeBridgeId: null })
    expect(picked).toBeUndefined()
  })

  // 规则 2: native-host 且 activeBridgeId 命中 —— 挑同时含 pageFrame.html 与 bridgeId=BID 的 guest。
  it('规则2: nativeHost=true 且 activeBridgeId 命中，挑对应 bridge 的 pageFrame guest', () => {
    const targets = [workbench, shell, guestB1, guestB2]
    const picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: 'b2' })
    expect(picked).toBe(guestB2)
  })

  // 规则 2 优先级: 当 active=b2 时，必须挑 b2 而不是先出现的 b1（active-bridge 优先于顺序）。
  it('规则2优先级: active=b2 时优先 b2，即便 b1 在列表中更靠前', () => {
    const targets = [guestB1, guestB2] // b1 先出现
    const picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: 'b2' })
    expect(picked).toBe(guestB2)
  })

  // 规则 3: native-host 但 active bridge 没有匹配项 —— 退回首个任意 bridge 的 pageFrame guest。
  it('规则3: nativeHost=true 但 activeBridgeId 无匹配，退回首个 pageFrame guest', () => {
    const targets = [workbench, guestB1, guestB2]
    const picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: 'b999' })
    expect(picked).toBe(guestB1)
  })

  // 规则 3: native-host 且 activeBridgeId 为 null —— 同样退回首个 pageFrame guest。
  it('规则3: nativeHost=true 且 activeBridgeId=null，退回首个 pageFrame guest', () => {
    const targets = [workbench, guestB1, guestB2]
    const picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: null })
    expect(picked).toBe(guestB1)
  })

  // 规则 4: native-host 且完全没有 pageFrame guest —— 优雅降级到 localhost:7788 shell。
  it('规则4: nativeHost=true 且无任何 pageFrame guest，降级到 7788 shell', () => {
    const targets = [workbench, shell]
    const picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: 'b2' })
    expect(picked).toBe(shell)
  })

  // 规则 4 边界: native-host、无 pageFrame guest 且无 shell —— 返回 undefined。
  it('规则4边界: nativeHost=true 且既无 pageFrame guest 又无 7788 shell，返回 undefined', () => {
    const targets = [workbench]
    const picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: 'b2' })
    expect(picked).toBeUndefined()
  })

  // workbench target 绝不能被当作 simulator 选中（任何模式下）。
  it('约束: workbench(entries/main/index.html) 永不被选为 simulator（非 native）', () => {
    const targets = [workbench]
    const picked = selectSimulatorTarget(targets, { nativeHost: false, activeBridgeId: null })
    expect(picked).toBeUndefined()
  })

  it('约束: workbench(entries/main/index.html) 永不被选为 simulator（native，仅有 workbench）', () => {
    const targets = [workbench, noUrl]
    const picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: null })
    expect(picked).toBeUndefined()
  })

  // 规则 5: 缺 url 的 target 被安全跳过，不抛错；正确的 target 仍被选中。
  it('规则5: 无 url 的 target 被跳过且不抛错（非 native，仍挑到 shell）', () => {
    const targets = [noUrl, shell]
    let picked: Target | undefined
    expect(() => {
      picked = selectSimulatorTarget(targets, { nativeHost: false, activeBridgeId: null })
    }).not.toThrow()
    expect(picked).toBe(shell)
  })

  it('规则5: 无 url 的 target 被跳过且不抛错（native，仍挑到 active guest）', () => {
    const targets = [noUrl, guestB1, guestB2]
    let picked: Target | undefined
    expect(() => {
      picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: 'b2' })
    }).not.toThrow()
    expect(picked).toBe(guestB2)
  })

  it('规则5: 全部 target 都缺 url，返回 undefined 且不抛错', () => {
    const targets = [noUrl, { type: 'page' } as Target]
    let picked: Target | undefined
    expect(() => {
      picked = selectSimulatorTarget(targets, { nativeHost: true, activeBridgeId: 'b2' })
    }).not.toThrow()
    expect(picked).toBeUndefined()
  })

  it('边界: 空 targets 列表，两种模式都返回 undefined', () => {
    expect(selectSimulatorTarget([], { nativeHost: false, activeBridgeId: null })).toBeUndefined()
    expect(selectSimulatorTarget([], { nativeHost: true, activeBridgeId: 'b2' })).toBeUndefined()
  })
})

describe('target-manager setters 存在性', () => {
  // 仅断言 setter 被导出且为函数；其连接副作用依赖 CDP，不在单测范围内。
  it('setNativeHost 被导出且为函数', () => {
    expect(typeof setNativeHost).toBe('function')
  })

  it('setActiveBridgeId 被导出且为函数', () => {
    expect(typeof setActiveBridgeId).toBe('function')
  })
})
