# Native-host 面板快照

## 当前数据路径

native-host 是 devtools 唯一的 simulator 运行时。页面 DOM 位于 render-host
`<webview>`，service 状态位于隐藏的 service-host 窗口；simulator 顶层 preload
不能直接读取二者。

因此 WXML、AppData、Storage 面板都从主进程取数据。renderer 的
`usePanelData` 只创建三种 IPC source，并用编译就绪状态控制是否连接
（`packages/devtools/src/renderer/modules/main/features/project-runtime/controllers/use-panel-data.ts:27-51`）。

```
render-host DOM ──> simulator-wxml ──> SimulatorWxmlChannel ──> ConnectedWxmlPanel
service setData ─> simulator-appdata -> SimulatorAppDataChannel -> ConnectedAppDataPanel
CDP DOMStorage ──> simulator-storage -> SimulatorStorageChannel -> ConnectedStoragePanel
```

这三条路径共用的契约是“seed 当前全量状态，再订阅完整更新”，不是旧
`miniapp-snapshot:push/pull` 通道。

## WXML

`setupSimulatorWxml` 通过 active render guest 的 `RenderInspector` 读取树。
面板可见时：

- `GetSnapshot` 返回当前全量树；
- `SetActive(true)` 安装 DOM observer 并 seed；
- `domReady`、活动页变化或 DOM mutation 触发重新读取；
- 同时只允许一个 pull；中途的新请求合并成一次后续 pull；
- `seq` 只用于 latest-wins，隐藏后迟到结果不会推送。

依据：`packages/devtools/src/main/services/simulator-wxml/index.ts:32-86`、
`packages/devtools/src/main/services/simulator-wxml/index.ts:88-154`。

## AppData

`setupSimulatorAppData` 监听 service→render 的 setData 消息，按 app 维护一个
`AppDataAccumulator`。面板只读取活动 app：

- `GetSnapshot` 返回 accumulator 的完整快照；
- 页面 bridge 销毁时 `evictBridge` 清掉该页；
- `SetData` 校验 `bridgeId` 和非空 patch，再发给 owning service WCV；
- 非活动 app 的更新不推给 renderer。

依据：`packages/devtools/src/main/services/simulator-appdata/index.ts:48-102`、
`packages/devtools/src/main/services/simulator-appdata/index.ts:104-134`。

## Storage

Storage 由主进程通过 CDP `DOMStorage` 读取，不依赖 simulator preload。
renderer source 使用 `SimulatorStorageChannel` 完成 seed、订阅和写操作。
入口见
`packages/devtools/src/renderer/modules/main/features/right-panel/storage-source.ts:1-120`
与
`packages/devtools/src/main/services/simulator-storage/index.ts:1-220`。

## renderer source 边界

`usePanelData` 不再包含 `useNativeChannelSnapshot`。当前连接、可见性、seed、
订阅和写操作由 `@dimina-kit/inspect` 的 Connected panel 与 devtools 的三种 IPC source
共同承担
（`packages/devtools/src/renderer/modules/main/features/project-runtime/controllers/use-panel-data.ts:1-51`）。

devtools source 文件：

| 面板 | renderer source |
|---|---|
| WXML | `packages/devtools/src/renderer/modules/main/features/right-panel/wxml-source.ts` |
| AppData | `packages/devtools/src/renderer/modules/main/features/right-panel/appdata-source.ts` |
| Storage | `packages/devtools/src/renderer/modules/main/features/right-panel/storage-source.ts` |

## 旧 preload snapshot API

`createMiniappSnapshotHost`、`createWxmlSource` 与
`MiniappSnapshotChannel` 仍保留为 deprecated 公共面。内置 native-host 路径不使用它们：

- 顶层 simulator WCV 没有 embedder，`sendToHost` 无接收端；
- renderer 的旧 puller 已删除；
- 顶层 WXML observer 看不到子 render-host guest 的 DOM。

依据：`packages/devtools/src/preload/index.ts:15-37`、
`packages/devtools/src/preload/windows/simulator.ts:40-55`。

内置 simulator preload 仍直接启动 `createAppDataSource()`，但只为了维护
`window.__simulatorHook.appData` 与
`window.__simulatorData.getAppdata()` 这两个 automation/MCP surface；它不创建
`MiniappSnapshotHost`，也不发送 snapshot envelope
（`packages/devtools/src/preload/windows/simulator.ts:40-55`）。

旧 API 的 deprecation 注释仍写明目标版本，但当前文档不承诺删除时间；删除属于公共 API
兼容性决策，必须以实际版本发布计划为准。

## 不变量

- renderer 面板 state 以主进程 seed/push 的全量结果替换，不自行拼接运行时增量。
- WXML observer 只在面板可见时运行，隐藏或 teardown 后不允许迟到 pull 更新 UI。
- AppData 以 appId 隔离 accumulator，renderer 只显示活动 app。
- 页面 bridge 销毁必须同步从 AppData accumulator 驱逐。
- Storage、WXML、AppData 各有专用协议；不要把三者误写成共享
  `miniapp-snapshot:push/pull`。
