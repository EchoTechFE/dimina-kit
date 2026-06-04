# @dimina-kit/view-anchor

让一块主进程原生视图（Electron `WebContentsView`）始终贴住某个 DOM 元素的屏幕矩形，一对一绑定。

DOM 布局库（flexbox、dockview、react-resizable-panels……）都不管渲染进程与主进程之间那道边界，它们移动的永远只是 DOM 节点。`view-anchor` 就是跨过这道边界的桥：它测量目标元素的 `getBoundingClientRect()`，把得到的矩形交给一个 `publish` 回调（由你接上 IPC → `setBounds`），并在元素发生位移或缩放时重新发布。

核心不依赖 React、Electron 或任何宿主布局引擎。涉及 React 的代码只在适配层。

## 安装

```sh
pnpm add @dimina-kit/view-anchor
```

## 快速上手

命令式核心：

```ts
import { createViewAnchor } from '@dimina-kit/view-anchor'

const handle = createViewAnchor(target, {
  present: true,                 // 挂载原生视图
  publish: (bounds) => { ... },  // 接收实时矩形；由它负责 IPC → setBounds
})

handle.update({ present, publish }) // 应用新选项（会立即重新发布）
handle.dispose()                    // 停止观察；此后不再发布
```

React 适配层：

```tsx
import { useViewAnchor } from '@dimina-kit/view-anchor'

function DebugPanel({ visible }: { visible: boolean }) {
  const ref = useViewAnchor({
    present: visible,
    publish: publishSimulatorDevtoolsBounds,
  })
  // 原生视图会跟随这个占位 div；隐藏面板
  // （visible=false 或卸载）会让它收起，但不销毁。
  return <div ref={ref} className="h-full w-full" />
}
```

## 工作原理（一句话版）

- `present: true`：立即发布测量矩形，之后在每次 `ResizeObserver` 触发、窗口 `resize` 时**同步**重新发布（不走 RAF——原生 overlay 的 setBounds 本就慢一帧，RAF 再叠一帧会拖尾）。与上次逐字段相同的矩形会被去重跳过。x/y 取整但**允许负**（滚出边缘时跟随），width/height 钳到 ≥0。
- `present: false`：发布一次 `{0,0,0,0}` 并停止观察（已有的观察器一并拆除）。宿主把「面积为零」读作「摘除子视图，但保留其 `WebContents` 存活」，即收起而非销毁。
- `dispose()` 之后不再发布任何内容，也不会补发一帧零矩形（那是调用方的责任；React 适配层已替你在元素消失时处理好）。

## 反向：`createSizeAdvertiser`（内容尺寸回流）

正向让原生视图跟随 DOM；反向让 DOM 占位跟随内容。当一块 `WebContentsView` 的尺寸由它**自己的内容**主导时（例如交给下游控制的 toolbar），在**下游视图自己的渲染进程**里跑：

```ts
import { createSizeAdvertiser } from '@dimina-kit/view-anchor'

const handle = createSizeAdvertiser(contentWrapper, {
  axis: 'block',                 // 这个 advertiser 只主导一条轴（block=高 / inline=宽），不可变
  publish: (size) => { ... },    // 接收 { axis, extent }，由它负责 IPC → 宿主
})

handle.update(publish) // 换 publish（IPC 通道），并立即把当前尺寸发给它
handle.dispose()       // 停止观察；此后不再上报
```

它从 `ResizeObserver` 的 border-box 取主导轴尺寸（不调 `getBoundingClientRect`、不强制 reflow），`Math.round` + 钳零，复用与正向同一套 RAF 合并 + 去重。宿主收到尺寸后调整占位、再由正向把视图贴上去——两个单向原语经占位 div 串成一座双向桥。**注意 footgun**：`target` 必须在主导轴上 shrink-to-fit（其尺寸不能被宿主灌入的视图尺寸反向决定），否则跨进程环不收敛。详见 [`docs/bidirectional-design.md`](./docs/bidirectional-design.md)。

## 文档

- [`docs/mechanism.mdx`](./docs/mechanism.mdx) —— 正向完整机制：RAF 与陈旧帧安全性、`present` / 零矩形 / 卸载契约、React 18 StrictMode 生命周期。内嵌可交互 3D 演示 [`docs/anchor-3d.html`](./docs/anchor-3d.html)。
- [`docs/bidirectional-design.md`](./docs/bidirectional-design.md) —— 双向化设计：共享 `createMeasureLoop` 核心、单轴所有权与收敛性、信任边界、以及两个原语如何「锚」到一起。

## API

| 导出 | 类型 | 作用 |
|---|---|---|
| `createViewAnchor(target, opts)` | 函数 | 正向命令式核心，返回 `{ update, dispose }`。不依赖 React、不依赖 Electron。 |
| `useViewAnchor(opts)` | Hook | 正向 React 适配层，返回一个挂到占位元素上的 ref 回调。 |
| `createSizeAdvertiser(target, opts)` | 函数 | 反向命令式核心，返回 `{ update, dispose }`。下游量内容尺寸回流给宿主。 |
| `Bounds` | 类型 | `{ x, y, width, height }`，单位为 CSS 像素。 |
| `ViewAnchorOptions` / `ViewAnchorHandle` | 类型 | 正向核心的选项与句柄形状。 |
| `UseViewAnchorOptions` / `ViewAnchorRef` | 类型 | 正向适配层的选项与 ref 回调形状。 |
| `AdvertisedAxis` / `AdvertisedSize` | 类型 | 反向的轴（`'block'\|'inline'`）与帧载荷 `{ axis, extent }`。 |
| `SizeAdvertiserOptions` / `SizeAdvertiserHandle` | 类型 | 反向核心的选项与句柄形状。 |
