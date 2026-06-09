# 布局架构 demo：新架构下「最简 devtools」的窗口 + 页面布局

> 状态：**目标 host-facing 调用形态**（只演示布局，省略编译/CDP/业务细节）。
> 底层 4 primitive（Scope / Layout-Placement / Compositor / ControlBus）+ **ViewHandle
> （per-view 编排）+ capability(grants) + slot-token + layout client 现均已建**：
> `runtime.view().placeIn(win,{anchor}).applyPlacement().moveTo().dispose()` 真接 deck-app
> + 链式，native view 经 renderer `createDeckLayoutClient` 的 anchor **真跟 DOM slot**（slot-token
> A5-2，主进程 anti-spoof 校验）；`runtime.grants.issue` 绑 wcScope（P4，wc.id 复用安全），
> `runtime.view({keepAlive})` 寿命不漏（B3），`runtime.layout.command` 的 `layout.*` 特权命令经
> ControlBus.dispatch **grant 闸**（grants-fork，闸已上活生产路径）。**仍待建**：`deck.resize/
> popout/overlay` 高层糖 + targetScope per-target 检查。详见 `contracts/view-handle-build-plan.md`。
> 本文给出整体调用，让 host 代码长什么样一目了然。

## 架构一句话

一个**窗口** = 一个寿命 **Scope** + 一个 z 栈 **Compositor** + 一块 control-layer renderer（React，DOM 分栏）。
原生 `WebContentsView`（simulator / Chrome DevTools / overlay）由主进程经 **Compositor** 按 zone 盖在 DOM 之上，靠 **Layout/Placement** 的 DOM 占位锚点缝合位置；业务 React 经 **ControlBus** + capability 自助驱动布局。

> Electron 物理约束：原生 view 永远合成在 DOM 之上、不能 z 穿插。所以「浮在原生 DevTools 之上的下拉」本身必须是一块**原生 view**（放进最高 zone），不是 DOM。

## 主进程：`main.ts`

```ts
import { electronDeck } from '@dimina-kit/electron-deck'

// Compositor 的 z 分层：低在下、高在上
const Z = { CONTENT: 0, PANEL: 10, OVERLAY: 100 }

electronDeck({}, {
  backend: {
    async assemble(runtime) {
      // ── 1. 主窗口 = control-layer renderer + 寿命 Scope + Compositor
      const main = runtime.windows.create({ control: { url: 'app://project-shell' } })

      // ── 2. 打开项目：session 寿命 ⊂ 窗口寿命
      let session = null
      function openProject(path) {
        session = main.scope.child()                      // 关项目只 reset 它，窗口活着

        // 模拟器：原生 view，锚到 DOM 的 #simulator 占位
        runtime.view({ source: simulatorSource(path), scope: session })
               .placeIn(main, { zone: Z.CONTENT, anchor: '#simulator' })

        // 右侧 Chrome DevTools：另一块原生 view（z 更高）
        runtime.view({ source: { devtoolsFor: '#simulator' }, scope: session })
               .placeIn(main, { zone: Z.PANEL, anchor: '#devtools' })
      }

      // ── 3. 点 close → 退回 main 而非关窗（窗口寿命 > session 寿命）
      main.onClose(async () => {
        if (session) {
          await session.reset()                           // 优雅释放项目页全部资源
          main.bus.event('navigate').publish('project-list')
          session = null
          return 'keep'                                   // 留住窗口
        }
        return 'close'
      })

      // ── 4. 浮在原生之上的 overlay（settings / 被 DevTools 盖住的下拉）
      function showOverlay(src, anchorRect) {
        return runtime.view({ source: src, scope: main.scope })
                      .placeIn(main, { zone: Z.OVERLAY, anchorRect })   // 原生 z 栈最顶
      }                                                   // 返回 ViewHandle，.dispose() 关掉

      // ── 5. 把面板拽出成独立窗口（live-migrate，实测不重载/不丢 CDP）
      function popout(view) {
        const win = runtime.windows.create({ control: { url: 'app://popout-shell' } })
        // moveTo 只移「显示」（Compositor 跨窗 mount），寿命默认仍属原 session：
        // placement ≠ lifetime。要让 view 比原 session 活得久，显式 rehome 才走 Scope.adopt：
        view.moveTo(win, { zone: Z.PANEL, anchor: '#devtools', rehomeTo: win.scope })
      }

      // ── 6. 授权 control-layer 自助驱动布局（capability，不越权）
      runtime.grants.issue(main.controlWc, {
        scope: main.scope,                                // 只能动这个窗口子树
        commands: ['layout.resize', 'layout.reorder', 'layout.popout', 'layout.overlay'],
      })
    },
  },
})
```

## 控制层 renderer：`control-shell.tsx`（那块「底」）

```tsx
import { createDeckLayoutClient } from '@dimina-kit/electron-deck/client'

const deck = await createDeckLayoutClient()   // 自动拿主进程发的 grant

function ProjectShell() {
  return (
    <SplitView onResize={(rect) => deck.resize('#simulator', rect)}>
      {/* DOM 面板：CSS 布局，归 React */}
      <Toolbar onPopOutDevtools={() => deck.popout('view:devtools')} />

      {/* 原生 view 的占位「洞」：React 只画 div + 报 bounds，原生 view 由主进程盖上来 */}
      <div id="simulator" className="flex-1" />
      <div id="devtools" className="w-[360px]" />

      {/* 会被原生 DevTools 盖住的下拉 → 交框架开顶层原生 overlay */}
      <Dropdown onOpen={(btnRect) => deck.overlay({ url: 'app://menu' }, btnRect)} />
    </SplitView>
  )
}
```

## 每个调用背后是哪个 primitive

| demo 里的调用 | 底层 primitive | 状态 |
|---|---|---|
| `runtime.windows.create` / `main.scope` / `main.compositor` / `main.bus` / `main.onClose` | 窗口 + **Scope** + **Compositor** + **ControlBus** + close 决策机 | ✅ 已建 |
| `scope.child()` / `session.reset()` | **Scope** 嵌套寿命 + 完成栅栏 | ✅ 已建 |
| `runtime.view().placeIn(win,{anchor})` / `.applyPlacement()` / `.moveTo()` / `.dispose()` | **ViewHandle** 薄编排 + per-window Compositor 底座（链式）→ Compositor(✅)+Layout/Placement(✅)+Scope(✅) | ✅ 已建（slice 1 + moveTo + **slot-token A5-2**：anchored placeIn 推 slot-grant，native view 经 renderer anchor 真跟 DOM slot） |
| `runtime.grants.issue` / `runtime.layout.command` / capability 校验 | **capability** 授权层（绑 wcScope，wc.id 复用安全）+ grant 闸**上活生产路径** | ✅ 已建（P4 + grants-fork）；`layout.*` 命令经 ControlBus.dispatch **grant 闸**（无 grant→DECK_FORBIDDEN），`layout.* ⟺ 受闸` 强制；targetScope per-target 检查保留待 target-bearing 命令 |
| `createDeckLayoutClient`（renderer 侧）| 订阅 slot-grant→真硬化 `createPlacementAnchor`(followScroll/followGeometry/guardDisplayNone)→publish 发 `__deck:place`(带 slotToken，主进程 anti-spoof 校验) | ✅ 已建（`@dimina-kit/electron-deck/client`；`deck.resize/popout/overlay` 高层糖待建） |

## 整体调用的精髓

1. **窗口 = Scope（寿命）+ Compositor（z 栈）+ 控制层 renderer（DOM 布局）** 三件套。
2. **页面布局零代码在主进程**：原生 view `view.placeIn(zone, anchor)` 一句话挂进去；DOM 分栏归 React，靠 anchor 占位缝合。
3. **三个真实需求各一句话**：close 退回 main = `session.reset()`；下拉浮在 DevTools 上 = `placeIn(OVERLAY zone)`；popout = `view.moveTo(win)`。
4. **业务自助布局 = grant + layout client**：React 直接 `deck.resize/popout`，主进程不写布局逻辑。
