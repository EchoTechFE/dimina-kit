# Dimina DevTools 贡献者指南

本文收纳原先放在包 README 中的代码结构、构建、调试、安全和架构索引。使用桌面应用请先读[包 README](../README.md)；把它嵌入自己的 Electron 应用请读[库集成参考](./library-integration.md)。

## 目录

```text
src/
  main/
    api.ts                 公共根入口
    app/                   启动、生命周期与应用装配
    ipc/                   IPC handler 注册
    runtime/               devtools backend 与宿主窄契约
    services/              workspace、views、项目、设置、自动化等能力
    windows/               主窗口和设置窗口
  preload/
    windows/               各窗口的 preload 入口
    runtime/               simulator 与宿主桥
    instrumentation/       console、AppData 等探针
  renderer/                主界面和设置界面的 React 代码
  simulator/               native simulator 的 DeviceShell
  service-host/            小程序逻辑层页面与 preload
  shared/                  主进程、preload 和 renderer 共用的类型与频道
```

构建脚本还会产出 `dist/renderer`、`dist/simulator`、`dist/service-host`、`dist/render-host`、`dist/preload` 和 `dist/vscode-workbench` 等目录。不要手改 `dist` 产物。

## 构建与检查

在仓库根目录运行：

```bash
pnpm --filter @dimina-kit/devtools build
pnpm --filter @dimina-kit/devtools build:main
pnpm --filter @dimina-kit/devtools build:preload
pnpm --filter @dimina-kit/devtools build:renderer
pnpm --filter @dimina-kit/devtools build:simulator
pnpm --filter @dimina-kit/devtools build:native-host
pnpm --filter @dimina-kit/devtools build:workbench

pnpm --filter @dimina-kit/devtools check-types
pnpm --filter @dimina-kit/devtools lint
pnpm --filter @dimina-kit/devtools test
pnpm --filter @dimina-kit/devtools test:coverage
pnpm --filter @dimina-kit/devtools test:e2e
```

`pnpm --filter @dimina-kit/devtools dev` 会先执行完整 build，然后并行监听 renderer、simulator、主进程和 preload，最后启动 Electron。

## 架构索引

README 不再复制随实现变化很快的调用链。按问题进入对应文档：

| 问题 | 文档 |
| --- | --- |
| BrowserWindow、WebContentsView、partition、preload、IPC 与关闭顺序 | [Electron Container 架构](./electron-container.md) |
| native simulator、DeviceShell、render-host 与 soft reload | [模拟器渲染架构](./simulator-render-architecture.md) |
| Chrome DevTools 的 Console、Network、Elements 和 open-in-editor | [DevTools CDP 路由](./devtools-cdp-routing.mdx) |
| VS Code 工作台启动、文件镜像、保存与扩展 | [编辑器集成](./editor-integration.md) |
| dd/wx 类型如何进入 web tsserver | [VS Code 工作台类型提示](./vscode-workbench-typehints.md) |
| dock tree、panel 可见性和原生 view bounds | [项目窗口布局](./project-window-layout.md) 与 [Placement 对账](./view-placement-reconciler.md) |
| 页面栈和 TabBar | [页面栈](./page-stack.md) 与 [TabBar](./tab-bar.md) |
| service-host 预热和 reset | [服务宿主预热池](./prewarm-webview.md) |
| 文件与 `dmb-resource://` | [文件路径与文件系统](./file-system.md) |

## 原生视图与内置面板

主窗口 renderer 负责布局和 React 面板；simulator、Chrome DevTools、工作台、settings 和 popover 等原生内容由主进程创建 `WebContentsView`，再由 placement reconciler 统一放置。不要在其他模块直接对 `mainWindow.contentView` 增删受控 view。

WXML、AppData 和 Storage 没有通过 `chrome.devtools.panels.create()` 注册，而是在主窗口 renderer 中显示。Chrome DevTools 仍作为独立 `WebContentsView`，通过 CDP 转发获得 Console、Network 与 Elements 数据。当前数据链以 [DevTools CDP 路由](./devtools-cdp-routing.mdx) 和 [面板快照](./miniapp-snapshot.md) 为准。

IPC 频道常量集中在 `src/shared/ipc-channels.ts` 及其按域拆分的 shared 文件中。新增 handler 时使用已有 registry 和 schema，不在文档里维护第二份频道清单。

## 调试

- 主窗口 renderer 问题：打开主窗口自己的 Electron DevTools。
- 小程序逻辑层、网络或源码映射问题：查看 devtools 右侧的 Chrome DevTools，并对照 [DevTools CDP 路由](./devtools-cdp-routing.mdx)。
- 原生 view 不显示、层级错误或关闭后残留：先看 [Placement 对账](./view-placement-reconciler.md) 的 owner 与 generation 约束。
- 页面切换后才出现的问题：按真实用户路径至少再操作一次，不以第一次成功作为结论。

## 安全边界

主窗口、设置和 overlay renderer 使用 `contextIsolation`，并通过 preload 暴露受限 API。IPC handler 还会检查 sender。宿主新增 IPC 时必须使用 `instance.ipc`；宿主自建窗口必须先用 `instance.registerTrustedWindow(win)` 加入 sender 列表。

simulator 和小程序页面使用不同的 WebContents/guest。不要因为 simulator 顶层是受信页面，就放宽 render-host guest 的 `webPreferences`、导航限制或资源协议校验。窗口、preload、partition 与导航的当前设置见 [Electron Container 架构的安全与稳健性](./electron-container.md#6-安全与稳健性)。

内置 MCP server 默认不应暴露给不受信任的客户端。它可以读取调试数据、截屏并触发页面操作；只在受控的本机环境启用，也不要把监听端口通过公共网络或不受信任的 SSH 转发暴露出去。

## 发布前

文档改动至少检查 Markdown 链接与示例导入；代码改动按风险运行包内 lint、类型检查、单测和 e2e。提交或开 PR 前还要从仓库根运行 `./scripts/gate.sh`，并使用真实退出码判断结果。
