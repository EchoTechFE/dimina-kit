# DevTools MCP Server

devtools 内置的 [Model Context Protocol](https://modelcontextprotocol.io) 服务，把小程序的**编译、启动、日志、模拟器观测与操控**能力暴露给外部 AI 编码工具（Claude Code、Cursor 等），支撑「在别的项目里 vibe coding，让 AI 自己编译、自己看效果」的闭环。

## 启用与连接

MCP 默认**关闭**。在设置窗口打开 MCP 开关，或直接编辑 `<userData>/dimina-workbench-settings.json`：

```json
{ "mcp": { "enabled": true, "port": 7789 } }
```

启用后服务监听 `127.0.0.1:<port>`（默认 7789），传输为 HTTP + SSE：

- `GET /sse` — SSE 事件流（MCP 客户端的连接入口）
- `POST /message?sessionId=<id>` — 客户端 → 服务端的 JSON-RPC 消息

客户端配置示例：

```bash
# Claude Code
claude mcp add --transport sse dimina http://127.0.0.1:7789/sse

# Codex
codex mcp add dimina --url http://127.0.0.1:7789/sse
```

```json
// 通用 JSON 配置（Cursor 等）
{ "mcpServers": { "dimina": { "url": "http://127.0.0.1:7789/sse" } } }
```

启动成功时主进程日志输出 `[MCP] SSE server listening on http://127.0.0.1:7789/sse`；端口被占用时打印警告并跳过启动（不影响 devtools 其余功能）。

## 工具清单

### 项目生命周期（编译闭环）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `project_open` | `path`，`timeoutMs`（默认 180000） | 打开小程序项目：目录未注册则先注册，走与用户点击完全相同的渲染进程打开路径（编译 + 挂载模拟器），等编译落定后返回。编译失败返回 `isError`，提示用 `compile_logs` 查 stderr |
| `project_close` | — | 关闭当前会话，工作台回到项目列表 |
| `project_status` | — | 查询编译状态：`phase`（`idle` / `compiling` / `ready` / `error`）、`message`、`projectPath`、`watcherAlive`、`generation` |
| `project_wait_ready` | `afterGeneration?`，`timeoutMs`（默认 60000） | 等编译管线落定（`phase` 离开 `compiling`）。watcher 重编译**不会**经过 `compiling` 阶段，所以等待「改完文件后的重编译」必须先用 `project_status` 拿 `generation` 再传入 |
| `compile_logs` | `cursor`（默认 0），`limit`（默认 100），`stream?`（`stdout` / `stderr`） | 游标式增量拉取编译日志：把上次返回的 `nextCursor` 作为下次的 `cursor`，只收新行。缓冲区在每次全新 open 时重置；watcher 重编译续写同一时间线（`seq` 单调，旧游标跨 open 依然有效） |

### 模拟器（小程序运行页面）

| 工具 | 说明 |
| --- | --- |
| `simulator_get_overview` | 一次性定位快照：当前路由、页面栈深度、storage / appData keys、近期错误。会话开始时先调它，省掉多次探测 |
| `simulator_screenshot` | PNG 截图（预览当前渲染效果） |
| `simulator_console_logs` | 近期 console 输出（`limit` / `level` / `sinceTimestamp` 过滤） |
| `simulator_network_log` | 网络请求记录（`limit` / `minStatus` 过滤） |
| `simulator_get_dom` | DOM 树（`depth`，默认 3） |
| `simulator_evaluate` | 在模拟器页面里执行 JS（沙箱内的 render 页面，无 Node 能力） |
| `simulator_navigate` | 页面导航 / 重载 |
| `simulator_input` | 输入派发：`tap_coord` / `tap_selector` / `type` / `scroll` / `key` |

### 工作台（devtools 主窗口）

| 工具 | 说明 |
| --- | --- |
| `workbench_get_overview` / `workbench_screenshot` / `workbench_console_logs` / `workbench_network_log` / `workbench_get_dom` | 与 simulator 同形的只读观测（无 `workbench_evaluate`，见安全说明） |
| `workbench_list_targets` | 列出所有 CDP target |

## 典型工作流（vibe coding 闭环）

```
1. project_open { path: "/abs/path/to/miniapp" }     # 编译 + 启动到模拟器
2. simulator_screenshot / simulator_get_overview      # 看初始效果
3. （AI 在项目里改代码，watcher 自动重编译）
4. project_status                                     # 记下 generation
5. project_wait_ready { afterGeneration: <上一步的值> } # 等重编译落定
6. compile_logs { cursor: <上次 nextCursor> }          # 有问题看增量日志
7. simulator_input / simulator_screenshot             # 交互验证新效果
```

## 实现要点

- **单一真相源**：`workspace/session-status-store.ts`（编译状态 + `generation` 单调计数）与 `workspace/compile-log-buffer.ts`（`seq` 环形缓冲）是主进程权威；`workspace/status-tap.ts` 在 `ctx.notify` 这一个闸口上记账后再广播给渲染进程，MCP 读与 UI 显示派生自同一处。
- **打开路径归渲染进程**：`project_open` 不直接调 `workspace.openProject`（那只编译、不挂模拟器），而是经 `notify.windowOpenProject` 推送 `window:openProject`，让渲染进程走用户点击同款路径挂载 `ProjectRuntime`，再用 `waitForSettled({ afterGeneration })` 等结果——generation 守卫保证不会把上一个会话的 `ready` 当成本次结果。
- **注入方式**：`app.ts` 的 `setupMcp(context)` 组装窄接口 `McpProjectHost`（见 `tools/project-tools.ts`）传给 `startMcpServer(cdpPort, mcpPort, projectHost)`。

## 安全说明

- 默认关闭；仅监听 `127.0.0.1`，不要通过端口转发暴露到不可信网络。
- `workbench_evaluate` 已移除（主窗口只暴露只读诊断）；`simulator_evaluate` 保留但只作用于沙箱化的 render 页面。
- 任何连上该端口的本地进程都能操控模拟器、打开/关闭项目，只在可信的本机客户端上启用。
