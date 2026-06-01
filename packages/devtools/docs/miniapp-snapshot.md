# miniappSnapshot 框架

> devtools 面板数据的统一**快照**框架。
>
> 配套：[`workbench-model.md`](./workbench-model.md) 描述 host 的扩展模型（`workbench(config)` 单入口）；本文描述面板数据的统一快照框架。

## 摘要（TL;DR）

`miniappSnapshot` 是 devtools 各面板（AppData、WXML…）共用的一套数据同步框架。它把面板数据建模为一条**不可变全量快照流**，并坚持一个核心思想：

> **preload 是唯一数据源（单一真相源），renderer 只是快照的纯投影。**

数据源每次只向 renderer 推送**全量、不可变的快照**，renderer 端永远只做「整份替换」，不做任何增量拼接。由此，reload / crash / relaunch 后的重同步成为框架的**结构保证**，新增面板只需实现一个数据源接口即可白送 push / pull / 自动化读取 / 重同步。

## 1. 背景：单一真相源不变式

devtools 的右侧面板要把 simulator `<webview>` 里运行的小程序状态，实时映射给开发者。这里的真相源（preload 内存 cache）每次 webview reload 都会被新的 JS 上下文清空，而 renderer 的 React state 不随之重建——若 renderer 靠**增量事件**自己拼状态，两者必然漂移。

```mermaid
flowchart LR
  subgraph SIM["simulator &lt;webview&gt; · 每次 reload 重建"]
    CACHE["preload 内存 cache<br/>（真相源 · reload 即清空）"]
  end
  subgraph RENDERER["main-window renderer · 不随 reload 重建"]
    MIRROR["React 镜像 state<br/>（增量拼接 · 跨 reload 持久）"]
  end
  CACHE -- "增量事件" --> MIRROR
  CACHE -. "reload 后清空，<br/>但镜像没人通知" .-x MIRROR
```

`miniappSnapshot` 用一条不变式消除这类漂移：**preload 持有全部状态并整份推送，renderer 只做投影、零增量拼接。** push / pull / reload 重同步由框架统一提供，新增面板复用同一套机制，不再各写一遍。

## 2. 设计目标与非目标

把上述问题翻译成可执行的目标：

**目标**

- **G1 单一真相源**：preload 持有状态，renderer 只是投影。
- **G2 只传全量不可变快照**：renderer 端零增量拼接。
- **G3 重同步是结构保证**：reload / crash / relaunch 后的重同步由框架结构保证，而非靠开发者「记得去做」。
- **G4 新增面板成本极低**：≈ 实现一个 `MiniappSnapshotSource` + 注册一行，push / pull / 自动化读取 / 重同步全部白送。
- **G5 统一通道**：一套通用通道与协议，不再每个面板各造一条频道。

**非目标**

- **N1 不覆盖流式数据**：Console 日志是 append-only 流，属于另一种数据形态。
- **N2 不接管 Storage**：其数据源是主进程 CDP，且 localStorage 跨 reload 持久，不属于本类 bug。
- **N3 不追求增量传输优化**：先做全量；真有性能压力时，框架内部可透明加 diff，consumer 无感。

## 3. 核心思路与概念

思路很简单：**不要再让 renderer 自己拼状态**。preload 每次把当前的完整状态打包成一份**快照**整体送过去，renderer 收到就整份替换。状态由谁拥有、由谁推送、何时重同步，全部收敛到一处。

为此引入五个概念，先建立词汇表：

| 概念 | 角色 |
|---|---|
| 快照（snapshot） | 某面板在某一刻的**全量、不可变**状态；不是单独的导出类型，而是各 source 自定义的 `T`，经 `SnapshotEnvelope<T>.data` 传输 |
| `SnapshotEnvelope<T>` | **信封**：快照 + 元数据（`id` / `seq` / `ts`）的传输单元 |
| `MiniappSnapshotSource<T>` | **数据源**：preload 侧观测运行时、产出快照 |
| `MiniappSnapshotHost` | **中枢**：preload 侧管理所有数据源的生命周期与收发 |
| `useMiniappSnapshot<T>` | renderer 侧通用 hook：把信封**投影**成 React state |

### 接口定义

```ts
// 数据源（Source）：一个数据源产出一种快照
interface MiniappSnapshotSource<T> {
  readonly id: SnapshotSourceId          // 'appdata' | 'wxml' | ...
  snapshot(): T                          // 当前全量快照（真相源）
  start(emit: () => void): void          // 开始观测；状态变化时调用 emit()
  dispose(): void                        // 释放观测器
}

// 信封（Envelope）：快照的传输单元
interface SnapshotEnvelope<T> {
  id: SnapshotSourceId
  seq: number    // 全局单调递增，跨 source 共享 —— 排序 / 时间线 / 跨面板关联
  ts: number     // Date.now()
  data: T        // 全量快照
}

// 中枢（Host）
interface MiniappSnapshotHost {
  register<T>(source: MiniappSnapshotSource<T>): void
  install(): () => void                  // 启动所有 source，返回 disposer
}
```

记住一句话：**`MiniappSnapshotSource` 是唯一需要为新面板实现的东西**，其余全部复用。

## 4. 架构总览

整体由三层组成：preload 侧的**数据源 + 中枢**、两条通用**传输通道**、renderer 侧的**通用 hook**。下图展示这三层如何串联——注意所有数据源都汇入同一个 Host，所有面板都复用同一个 hook：

```mermaid
flowchart TB
  subgraph WV["simulator &lt;webview&gt;（preload 上下文，每次 reload 重建）"]
    direction TB
    OBS1["Worker 插桩"] --> SRC1["AppDataSource"]
    OBS2["MutationObserver"] --> SRC2["WxmlSource"]
    SRC1 --> HOST["MiniappSnapshotHost"]
    SRC2 --> HOST
    HOST --> AUTO["window.__miniappSnapshot<br/>.get(id) / .ids()"]
  end

  subgraph TRANSPORT["传输层（2 个通用通道）"]
    PUSH["miniapp-snapshot:push<br/>SnapshotEnvelope"]
    PULL["miniapp-snapshot:pull<br/>{ id }"]
  end

  subgraph RD["main-window renderer（不随 reload 重建）"]
    direction TB
    IPC["&lt;webview&gt; ipc-message"] --> HOOK["useMiniappSnapshot({ id, initial,<br/>simulatorRef, enabled })"]
    HOOK --> P1["AppDataPanel"]
    HOOK --> P2["WxmlPanel"]
  end

  HOST -- sendToHost --> PUSH --> IPC
  HOOK -- "webview.send" --> PULL --> HOST
  AUTO -. "executeJavaScript" .-> AUTOMATION["自动化 / MCP / e2e"]
```

每层的职责分工：

- **数据源**：preload 内每个 source 把观测器（Worker 插桩、MutationObserver）封在内部，对外只暴露 `snapshot()`。
- **中枢**：`Host` 负责全部横切逻辑——启动数据源、接收 `pull`、发出 `push`、暴露自动化访问器、释放资源。
- **renderer**：只有一个通用 hook，按 `id` 把信封投影成 state。

> **native-host 例外**：上图描述的是默认 simulator-preload 路径。开启 native-host 时，页面 DOM 与 service 逻辑跑在独立 webContents 里，simulator preload 会跳过 `WxmlSource` 注册（仅注册 `AppDataSource`）；renderer 改从主进程通道 `SimulatorWxmlChannel` / `SimulatorAppDataChannel` 取 WXML 与 AppData，不走本框架的 push/pull 传输。

## 5. 调用链路（时序图）

下面四张时序图覆盖框架的四个关键时刻：安装、运行时更新、主动刷新、reload 重同步。

### 5.1 首次加载 / 安装

下图展示 `install()` 启动时发生了什么——注意每个 source 在装好观测器后**立即推送一次初始快照**：

```mermaid
sequenceDiagram
  autonumber
  participant WV as simulator preload
  participant Host as MiniappSnapshotHost
  participant Src as XxxSource
  participant RD as renderer useMiniappSnapshot

  WV->>Host: createMiniappSnapshotHost()
  WV->>Host: register(appDataSource)
  WV->>Host: register(wxmlSource)
  WV->>Host: install()
  loop 每个已注册 source
    Host->>Src: start(emit)
    Note over Src: 装好观测器（Worker 插桩 / MutationObserver）
    Host->>Src: snapshot()
    Src-->>Host: 空快照（appdata={bridges:[],entries:{}} / wxml=null）
    Host->>RD: push(SnapshotEnvelope{seq,ts,data:空})
    RD->>RD: setData(空) —— 初始即正确
  end
  Host->>Host: 注册 onHostMessage(pull)
  Host->>Host: 暴露 window.__miniappSnapshot（get / ids）
  Note over WV,RD: 小程序随后启动 → 见 5.2
```

**关键点**：`install()` 对每个 source **必然先 publish 一次初始快照**。这是框架的固定动作，不依赖任何 source「记得」去做。

### 5.2 运行时更新（push）

下图展示小程序运行时状态变化如何流到面板——注意推送的**始终是全量快照**，renderer 端没有 reducer：

```mermaid
sequenceDiagram
  autonumber
  participant APP as 小程序运行时
  participant Src as XxxSource
  participant Host as MiniappSnapshotHost
  participant RD as renderer
  participant UI as 面板组件

  APP->>Src: 状态变化<br/>（setData 的 ub 消息 / DOM mutation）
  Src->>Src: 更新内部 cache
  Src->>Host: emit()
  Host->>Host: seq++ ; 组装 SnapshotEnvelope
  Host->>RD: push(envelope) —— 始终全量
  RD->>RD: 丢弃 seq ≤ 已见 的过期信封
  RD->>RD: setData(envelope.data) —— 纯替换，无 reducer
  RD->>UI: 重渲染
```

**全量 + 单调 `seq`** 带来「后写覆盖」语义：迟到 / 乱序的信封不可能部分污染状态。

### 5.3 主动刷新（pull）

下图展示用户点「刷新」按钮时的链路——注意 pull 与 push 复用**同一条** `publish` 路径：

```mermaid
sequenceDiagram
  autonumber
  participant UI as 面板「刷新」按钮
  participant RD as useMiniappSnapshot
  participant Host as MiniappSnapshotHost
  participant Src as XxxSource

  UI->>RD: refresh()
  RD->>Host: webview.send(pull, { id })
  Host->>Src: snapshot()
  Src-->>Host: 当前全量快照
  Host->>RD: push(envelope)
  RD->>RD: setData(envelope.data)
```

push 与 pull 走同一条 `publish` 路径，因此不存在「两套快照逻辑」。

### 5.4 重新编译 / reload 重同步

webview reload 后，preload 上下文与旧 cache 一并销毁，新上下文重新执行 `install()`。renderer 的 `<webview>` 元素本身没变、`ipc-message` 监听一直在，所以**必然收到新的空快照**，旧面板状态被整份替换清掉：

```mermaid
sequenceDiagram
  autonumber
  participant U as 用户
  participant RD as renderer
  participant WVOLD as 旧 preload 上下文
  participant WVNEW as 新 preload 上下文
  participant Host as 新 Host

  U->>RD: 点「重新编译」
  RD->>WVOLD: webview.reload()
  Note over WVOLD: 整个 JS 上下文销毁，旧 cache 随之消失
  WVNEW->>Host: install() 重新执行
  loop 每个 source
    Host->>RD: push(空快照)
    RD->>RD: setData(空) —— 旧面板状态被替换清掉
  end
  Note over RD: renderer 的 &lt;webview&gt; 元素未变，<br/>ipc-message 监听始终在 → 必收到空快照
  WVNEW->>Host: 新页面启动 → 真实快照陆续 push
  Host->>RD: push(真实快照)
```

**关键点**：reload 重同步 = 5.1 的 install 流程**原样重跑**。没有任何一个 source 需要「记得」去重同步——它本就是 `install()` 的固有步骤。新注册的 source 自动获得这一保证。

### 5.5 source 生命周期

下图汇总一个数据源从注册到释放的状态机——观测期间每次状态变化都触发一次 publish：

```mermaid
stateDiagram-v2
  [*] --> Registered: host.register(source)
  Registered --> Observing: install() → start(emit)
  Observing --> Observing: 状态变化 → emit() → publish
  Observing --> Disposed: install() 的 disposer / webview 卸载
  Disposed --> [*]
```

## 6. 通道与协议

整个框架只用**两条通用通道**，所有面板共用：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `miniapp-snapshot:push` | preload → renderer（`sendToHost`） | `SnapshotEnvelope<T>` |
| `miniapp-snapshot:pull` | renderer → preload（`webview.send`） | `{ id: SnapshotSourceId }` |

协议要点：

- 一条共享 push + 一条共享 pull 服务所有面板；没有 per-panel 通道，新增面板**不需要新频道**。
- `seq` **全局单调**：每个信封只承载一个 source（`publish(source)` 一次发一份），`seq` 仅提供全局排序 / 丢弃过期信封的语义，不保证多面板「同一时刻」的原子切面。

## 7. renderer 投影模型

renderer 侧只有一个通用 hook，它把信封流投影成 React state。参数以单个对象传入：

```ts
function useMiniappSnapshot<T>(params: {
  id: SnapshotSourceId
  initial: T
  simulatorRef: RefObject<HTMLElement | null>
  enabled: boolean
}): {
  data: T
  seq: number
  refresh: () => void
}
```

行为约定：

- 对 `<webview>` 只挂一次 `ipc-message` 监听；`enabled` 为 false 时不挂监听（首次以 `useState(initial)` 初始化），但不会把已收到的 `data` 重置回 `initial`。
- `data` 永远是「最后一份快照」，没有任何增量 reducer；据全局 `seq` 丢弃过期 / 乱序信封。
- 面板里的 **UI 态**（如 AppData 当前选中的 tab `activeBridgeId`）留在 renderer，作为对 `data` 的**单点派生**：由 `data.bridges` 推出 id 列表后，`activeBridgeId = selectedBridgeId && bridgeIds.includes(selectedBridgeId) ? selectedBridgeId : bridgeIds.at(-1) ?? null`（用户手选优先，否则跟随最新 page）。

## 8. 这套框架还能解决什么

把「面板数据」统一成**不可变全量快照流**之后，下面这些能力，数据层要么免费、要么近免费：

| 能力 | 说明 |
|---|---|
| **消灭整类失步 bug** | reload 漂移、`activeBridgeId` 不一致、`entries` 泄漏/乱序复活——结构上不再可能 |
| **统一自动化 / MCP** | `window.__miniappSnapshot.get(id)` 一个同步 API 覆盖所有面板，供主进程 / e2e / MCP 经 `executeJavaScript` 读取 |
| **全局排序 / 丢弃过期** | 全局 `seq` 给每份信封一个单调序号，renderer 据此丢弃迟到 / 乱序信封；它提供的是排序语义，不是多面板同一时刻的原子切面 |
| **面板可单测** | renderer 面板变成 `snapshot → UI` 的纯函数，喂 fixture 即可测，无需真机 |
| **统一恢复路径** | recompile / crash / relaunch / 切项目 全部走同一条 `install()→publish` 恢复链 |
| **下游 host 扩展点** | `host.register()` 即扩展点，下游可注册自定义快照源/面板 |

**核心价值**：它不是「修一个 bug」，而是把这一整**类**问题在结构上变成不可能，并把面板数据统一成可被自动化读取的资产。

## 9. 取舍与风险

任何设计都有代价，这里把权衡讲清楚：

- **全量传输开销**：AppData / WXML 快照体量都不大，且每次事件本就重建快照。devtools 非热路径，全量传输可接受。
- **不适用流式数据**：Console 日志是 append-only 流，属于另一种数据形态，不塞进本框架。
- **Storage 不纳入**：其数据源在主进程 CDP，且 localStorage 跨 reload 持久——不属本类 bug。
- **seq 语义**：全局 `seq` 给的是「排序」，不是「多面板一致切面」——多面板按 `seq` 对齐到的是最近一次发布的相对先后，而非同一时刻的原子取样。

## 10. 附录：新增一个面板

完整示例——新增一个 Network 面板，只需「实现一个数据源 + 注册一行 + 用一个 hook」：

```ts
// preload —— 实现一个 source
function createNetworkSource(): MiniappSnapshotSource<NetworkSnapshot> {
  let requests: NetworkRequest[] = []
  return {
    id: 'network',
    snapshot: () => ({ requests }),
    start(emit) { hookFetch((req) => { requests = [...requests, req]; emit() }) },
    dispose() { unhookFetch() },
  }
}

// preload 入口 —— 注册一行
host.register(createNetworkSource())

// renderer —— 一个 hook
const { data, refresh } = useMiniappSnapshot({
  id: 'network',
  initial: { requests: [] },
  simulatorRef,
  enabled: ready,
})
```

push / pull / 自动化读取 / reload 重同步，全部自动获得。

## 11. 文件清单

| 文件 | 角色 |
|---|---|
| `src/preload/miniapp-snapshot/types.ts` | `MiniappSnapshotSource<T>` / `SnapshotEnvelope<T>` / `MiniappSnapshotHost` 接口定义 |
| `src/preload/miniapp-snapshot/host.ts` | 中枢 `MiniappSnapshotHost`：`register` / `install` + push/pull + `window.__miniappSnapshot` 访问器 |
| `src/preload/instrumentation/app-data.ts` | `AppDataSource`（Worker 插桩 → AppData 快照） |
| `src/preload/instrumentation/wxml.ts` | `WxmlSource`（MutationObserver → WXML 快照） |
| `src/renderer/modules/main/features/project-runtime/controllers/use-miniapp-snapshot.ts` | renderer 通用 hook `useMiniappSnapshot`：信封 → React state 投影 |
| `src/shared/ipc-channels.ts` | `MiniappSnapshotChannel`（`miniapp-snapshot:push` / `miniapp-snapshot:pull`） |

> 面板数据的 host 扩展模型（`workbench(config)` 单入口）见 [`workbench-model.md`](./workbench-model.md)。
