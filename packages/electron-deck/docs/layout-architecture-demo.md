# 布局架构 demo：「最简 devtools」的窗口 + 页面布局

> 本文演示高层 host API 的调用形态（只演示布局，省略编译/CDP/业务细节），让 host
> 代码长什么样一目了然。底层四原语（Scope / Layout-Placement / Compositor / ControlBus）
> + ViewHandle（per-view 编排）+ capability(grants) + slot-token + layout client 缝出这套调用：
> `runtime.view({source,scope}).placeIn(win,{zone,anchor})` 把原生 view 挂进窗口，native view
> 经 renderer `createDeckLayoutClient({bridge})` 的 anchor 真跟 DOM slot（slot-token + 主进程
> anti-spoof 校验）。`placeIn` / `applyPlacement` 链式（返回 handle）；`moveTo` / `dispose`
> 是终态（返回 `Promise`）。完整运行示例见 `examples/layout-demo/`，原语契约见
> [`architecture.md`](./architecture.md) §4。
>
> ⚠️ 这套高层 surface（`runtime.windows` / `runtime.view` / `runtime.scopes` / `runtime.grants`
> / `runtime.layout`）`@experimental`：已实装并接线，但当前唯一调用者是 `examples/layout-demo`
> 与 `spike/popout`，签名未 API 稳定。devtools 等下游宿主走 `RuntimeBackend` + `ownsWindows:true`，
> 不碰这层（理由见 [`../../devtools/docs/deck-adoption-decision.md`](../../devtools/docs/deck-adoption-decision.md)）。

## 架构一句话

一个**窗口** = 一个寿命 **Scope** + 一个 z 栈 **Compositor** + 一块 control-layer renderer（React，DOM 分栏）。
原生 `WebContentsView`（simulator / Chrome DevTools / overlay）由主进程经 **Compositor** 按 zone 盖在 DOM 之上，靠 **Layout/Placement** 的 DOM 占位锚点缝合位置；业务 React 经 **ControlBus** + capability 自助驱动布局。

> Electron 物理约束：原生 view 永远合成在 DOM 之上、不能 z 穿插。所以「浮在原生 DevTools 之上的下拉」本身必须是一块**原生 view**（放进最高 zone），不是 DOM。

## 主进程：`main.ts`

```ts
import { app, ipcMain } from 'electron'
import { startElectronDeck } from '@dimina-kit/electron-deck'

// Compositor 的 z 分层：低在下、高在上
const Z = { SIMULATOR: 0, DEVTOOLS: 10, OVERLAY: 100 }

const { ready } = startElectronDeck({
  app: {
    window: { width: 900, height: 520 },
    // 声明式主窗口入口：framework 建好主窗口后自动 load 这个 source
    source: { url: 'app://control-shell' },
  },
  backend: {
    // framework 建的主窗口用 host 的 preload（exposeDeckLayoutBridge 需要 sandbox:false）
    mainWindowWebPreferences() {
      return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
    },

    async assemble(runtime) {
      // ── 1. 主窗口：framework 建好后经 Window facade 交回（非 ownsWindows）
      const main = runtime.windows.main            // DeckWindow
      const mainWin = main.window                  // 原生 BrowserWindow

      let session = null
      // ── 2. 打开项目：window-rooted session 寿命 ⊂ 窗口寿命
      ipcMain.on('open-project', () => {
        session = main.newSession()                // 关项目只 reset 它，窗口活着

        // 模拟器：原生 view，锚到 DOM 的 #simulator 占位
        runtime.view({ source: simulatorSource(), scope: session })
               .placeIn(mainWin, { zone: Z.SIMULATOR, anchor: '#simulator' })

        // 右侧 Chrome DevTools：另一块原生 view（z 更高）
        runtime.view({ source: devtoolsSource(), scope: session })
               .placeIn(mainWin, { zone: Z.DEVTOOLS, anchor: '#devtools' })
      })

      // ── 3. 点 close → 退回 main 而非关窗（窗口寿命 > session 寿命）
      main.onClose(async () => {
        if (session) {
          await session.reset()                    // 优雅释放项目页全部资源
          session = null
          return 'keep'                            // 留住窗口
        }
        return 'close'
      })

      // ── 4. 浮在原生之上的 overlay（settings / 被 DevTools 盖住的下拉）：
      // 一块原生 view 放进最高 zone，锚到一个 DOM 占位元素
      function showOverlay(src, anchor) {
        return runtime.view({ source: src, scope: session ?? main.newSession() })
                      .placeIn(mainWin, { zone: Z.OVERLAY, anchor })   // 原生 z 栈最顶
      }                                            // 返回 DeckViewHandle，.dispose() 关掉

      // ── 5. 把面板拽出成独立窗口（live-migrate，spike/popout 实测不重载/不丢 CDP）
      function popout(view) {
        const win = runtime.windows.create({ source: { url: 'app://popout-shell' } })
        // moveTo 移「显示」（Compositor 跨窗 mount）；rehome:true 才把寿命迁到新窗口
        // （placement ≠ lifetime；默认仅移显示，寿命仍属原 session）：
        view.moveTo(win.window, { zone: Z.DEVTOOLS, anchor: '#devtools', rehome: true })
      }

      // ── 6. 授权 control-layer 自助驱动特权布局命令（capability，不越权）
      runtime.layout.command('layout.collapse-sim', () => {
        /* host-side：隐藏 simulator view 等 */ return 'ok'
      })
      runtime.grants.issue(main.controlWc, {
        commands: ['layout.collapse-sim'],         // 只授这些 layout.* 命令
        targetScope: session,                      // window-rooted DeckSession
      })
    },
  },
})

ready.catch((err) => { console.error(err); app.quit() })
```

## 控制层 renderer：`control-shell.tsx`（那块「底」）

```tsx
import { createDeckLayoutClient } from '@dimina-kit/electron-deck/client'

// preload 里 `exposeDeckLayoutBridge()` 已把 turnkey bridge 挂到 window
const deck = createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })
// deck.dispose() 在卸载时停掉 anchor

function ProjectShell() {
  return (
    <div className="split">
      {/* DOM 面板：CSS 布局，归 React */}
      <Toolbar onOpenProject={(id) => window.__demoControl.openProject(id)} />

      {/* 原生 view 的占位「洞」：React 只画 div + 报 bounds，原生 view 由主进程盖上来。
          createDeckLayoutClient 内部的 view-anchor 用 ResizeObserver 量这些 slot，
          拖动 splitter → slot 尺寸变 → 自动 publish Placement → 原生 view 跟随。
          ZERO 显式 resize 代码。 */}
      <div id="simulator" className="flex-1" />
      <div id="splitter" />
      <div id="devtools" style={{ width: 360 }} />
    </div>
  )
}
```

## 每个调用背后是哪个 primitive

| demo 里的调用 | 底层 primitive |
|---|---|
| `runtime.windows.main` / `runtime.windows.create` / `main.window` / `main.controlWc` / `main.onClose` | 窗口 + **Scope** + **Compositor** + **ControlBus** + close 决策机 |
| `main.newSession()` / `session.reset()` / `session.dispose()` | **Scope** 嵌套寿命（window-rooted DeckSession）+ 完成栅栏 |
| `runtime.view({source,scope}).placeIn(win,{zone,anchor})` / `.applyPlacement()` / `.moveTo()` / `.dispose()` | **ViewHandle** 薄编排 + per-window Compositor 底座：Compositor + Layout/Placement + Scope。slot-token：anchored placeIn 推 slot-grant，native view 经 renderer anchor 真跟 DOM slot |
| `runtime.layout.command` / `runtime.grants.issue` / capability 校验 | **capability** 授权层（绑 control-wc senderId，wc.id 复用安全）+ grant 闸；`layout.*` 命令经 ControlBus.dispatch **grant 闸**（无 grant → `DECK_FORBIDDEN`） |
| `createDeckLayoutClient({bridge})`（renderer 侧）| 订阅 slot-grant → `createPlacementAnchor`(followScroll/followGeometry/guardDisplayNone) → publish 发 place（带 slotToken，主进程 anti-spoof 校验）；preload 的 `exposeDeckLayoutBridge()` 提供 turnkey `bridge` |

## 整体调用的精髓

1. **窗口 = Scope（寿命）+ Compositor（z 栈）+ 控制层 renderer（DOM 布局）** 三件套。
2. **页面布局零代码在主进程**：原生 view `view.placeIn(win, {zone, anchor})` 一句话挂进去；DOM 分栏归 React，靠 anchor 占位缝合，拖动 splitter 原生 view 自动跟随。
3. **三个真实需求各一句话**：close 退回 main = `session.reset()`；下拉浮在 DevTools 上 = `placeIn(OVERLAY zone)`；popout = `view.moveTo(win, {rehome:true})`。
4. **业务自助布局 = grant + layout client**：renderer 挂 `createDeckLayoutClient`，原生 view 自动跟 DOM；特权命令经 `runtime.layout.command` + `runtime.grants.issue` 授权，主进程不写布局逻辑。
