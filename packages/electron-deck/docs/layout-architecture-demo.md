# 布局架构 demo：「最简 devtools」的窗口 + 页面布局

本文给出 host-facing 调用形态——用 electron-deck 的 host-shell 原语拼出「最简 devtools」的窗口与页面布局长什么样（只演示布局，省略编译 / CDP / 业务细节）。可跑版在 `examples/layout-demo/`（离屏自证一次 renderer splitter 拖动让原生色块跟随、host 写零行 resize 代码）。

API 全貌见 `architecture.md`；契约见 `contracts/`。

## 架构一句话

一个**窗口** = 一个寿命 **Scope** + 一个 z 栈 **Compositor** + 一块 control-layer renderer（React，DOM 分栏）。原生 `WebContentsView`（simulator / Chrome DevTools / overlay）由主进程经 **Compositor** 按 zone 盖在 DOM 之上，靠 **Layout/Placement** 的 DOM 占位锚点缝合位置；业务 React 经 **ControlBus** + capability 自助驱动布局。

> Electron 物理约束：原生 view 永远合成在 DOM 之上、不能 z 穿插。所以「浮在原生 DevTools 之上的下拉」本身必须是一块**原生 view**（放进最高 zone），不是 DOM。

## 主进程：`main.ts`

```ts
import { startElectronDeck } from '@dimina-kit/electron-deck'

// Compositor 的 z 分层：低在下、高在上
const Z = { CONTENT: 0, PANEL: 10, OVERLAY: 100 }

startElectronDeck({
  app: { source: { url: 'app://project-shell' } },   // 框架建 + 自动加载主窗口
  backend: {
    async assemble(runtime) {
      // ── 1. 主窗口 = control-layer renderer + 寿命 Scope + Compositor
      const main = runtime.windows.main                 // DeckWindow

      // ── 2. 打开项目：session 寿命 ⊂ 窗口寿命
      let session = null
      function openProject(path) {
        session = main.newSession()                     // 关项目只拆它，窗口活着

        // 模拟器：原生 view，锚到 DOM 的 #simulator 占位
        runtime.view({ source: simulatorSource(path), scope: session })
               .placeIn(main.window, { zone: Z.CONTENT, anchor: '#simulator' })

        // 右侧 Chrome DevTools：另一块原生 view（z 更高）
        runtime.view({ source: { devtoolsFor: '#simulator' }, scope: session })
               .placeIn(main.window, { zone: Z.PANEL, anchor: '#devtools' })
      }

      // ── 3. 点 close → 退回 main 而非关窗（窗口寿命 > session 寿命）
      main.onClose(async () => {
        if (session) {
          await session.dispose()                       // 优雅释放项目页全部资源
          main.bus.event('navigate').publish('project-list')
          session = null
          return 'keep'                                  // 留住窗口
        }
        return 'close'
      })

      // ── 4. 浮在原生之上的 overlay（settings / 被 DevTools 盖住的下拉）
      function showOverlay(src, anchor) {
        return runtime.view({ source: src, scope: main.newSession() })
                      .placeIn(main.window, { zone: Z.OVERLAY, anchor })   // 原生 z 栈最顶
      }                                                  // 返回 DeckViewHandle，.dispose() 关掉

      // ── 5. 把面板拽出成独立窗口（live-migrate，不重载 / 不丢 CDP）
      function popout(view) {
        const win = runtime.windows.create({ control: { url: 'app://popout-shell' } })
        // moveTo 只移「显示」（Compositor 跨窗 mount），寿命默认仍属原 session：
        // placement ≠ lifetime。要让 view 比原 session 活得久，显式 rehome 才走 Scope.adopt：
        view.moveTo(win.window, { zone: Z.PANEL, anchor: '#devtools', rehome: true })
      }

      // ── 6. 授权 control-layer 自助驱动布局（capability，不越权）
      runtime.grants.issue(main.controlWc, {
        commands: ['layout.resize', 'layout.reorder', 'layout.popout', 'layout.overlay'],
      })
    },
  },
})
```

## 控制层 renderer：`control-shell.tsx`（那块「底」）

```tsx
import { createDeckLayoutClient } from '@dimina-kit/electron-deck/client'

const deck = createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })

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

| demo 里的调用 | 底层 primitive |
|---|---|
| `runtime.windows.create` / `runtime.windows.main` / `main.onClose` | 窗口 facade + close 决策机 |
| `main.newSession()` / `session.dispose()` | **Scope** 嵌套寿命 + 完成栅栏 |
| `runtime.view().placeIn(win,{anchor})` / `.applyPlacement()` / `.moveTo()` / `.dispose()` | **ViewHandle** 薄编排 → Compositor + Layout/Placement + Scope；anchored `placeIn` 推 slot-token，native view 经 renderer anchor 真跟 DOM slot |
| `runtime.grants.issue` / `runtime.layout.command` | **capability** 授权层 + grant 闸：`layout.*` 命令经 `ControlBus.dispatch` 判 grant（无 grant → `DECK_FORBIDDEN`） |
| `createDeckLayoutClient`（renderer 侧）| 订阅 slot-grant → 建硬化 `createPlacementAnchor`（followScroll / followGeometry / guardDisplayNone）→ publish 发 `__deck:place`（带 slotToken，主进程 anti-spoof 校验） |

## 集成约束（用这套布局引擎时要知道的）

- **顶层入口用 `startElectronDeck()`，不要顶层 `await electronDeck()`**：`electronDeck()` 内部 `await app.whenReady()`，而 Electron `ready` 要等 main 模块求值完才 fire，顶层 await 会死锁。`startElectronDeck()` 同步返回 `{ ready, dispose }`，装配仍严格在 whenReady 之后跑。
- **preload 是 ESM**：本包 preload dist 为 ESM，所以 `import { exposeDeckLayoutBridge }` 的 preload 文件须是 `.mjs`，且该窗口 `sandbox:false`（Electron 的 ESM-preload 要求）。`exposeDeckLayoutBridge()` 暴露 `window.__electronDeckLayoutBridge`，channel 名来自框架自身，无需手抄 IPC 字符串。
- **无打包器的 renderer 用 browser 端口**：`@dimina-kit/electron-deck/client/browser` 是依赖内联的浏览器 bundle（无 bare specifier），无需 import map 指向 view-anchor dist。
- **`config.app.source`**：框架拥有主窗口时（非 `ownsWindows:true`）自动加载该 source，host 不手调 `loadURL`；preload 仍经 `mainWindowWebPreferences()` 附加。
- **`DeckViewHandle` 暴露原生 view**：`webContents` / `bounds()` / `capturePage()` 直接读，截图 / 发消息无需 diff `mainWindow.contentView.children`。`bounds()` 在 view 未 placed / 隐藏 / dispose 后返回 `null`。
- **`runtime.scopes.create()` 铸 `DeckSession`**：把 view 绑到 session（`runtime.view({ scope })`），`session.dispose()` 一次拆完所有绑定 view；它也是 `grants.issue` 的 `targetScope`。

## 整体调用的精髓

1. **窗口 = Scope（寿命）+ Compositor（z 栈）+ 控制层 renderer（DOM 布局）** 三件套。
2. **页面布局零代码在主进程**：原生 view `view.placeIn(zone, anchor)` 一句话挂进去；DOM 分栏归 React，靠 anchor 占位缝合。
3. **三个真实需求各一句话**：close 退回 main = `session.dispose()`；下拉浮在 DevTools 上 = `placeIn(OVERLAY zone)`；popout = `view.moveTo(win)`。
4. **业务自助布局 = grant + layout client**：React 直接 `deck.resize/popout`，主进程不写布局逻辑。
