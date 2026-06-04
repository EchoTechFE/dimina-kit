# view-anchor 双向化重构设计（提案）

> 状态：契约草案，经四轮对抗评审收敛。本页只定契约，不含实现。

## 1. 目标

把 view-anchor 从「单向锚定」重构成「**双向几何桥**」，且保持引擎无关、传输注入：

- **正向（已有）** `createViewAnchor(target, { present, publish })` —— 宿主渲染进程量 DOM 占位矩形 → `publish(bounds)` → IPC → 主进程 `WebContentsView.setBounds`。
- **反向（新增）** `createSizeAdvertiser(target, { axis, publish })` —— 下游 WebContentsView 自己的渲染进程量自身内容尺寸 → `publish(size)` → IPC → 宿主，宿主据此调整占位尺寸，再经正向把视图贴上去。

动机：workbench 的 toolbar 改成「**交给下游控制**」的 WebContentsView，尺寸的事实来源从宿主翻到了下游一侧（典型：宽宿主主导、高下游内容主导），占位映射变成动态的。

非目标：不是同层渲染（合成器层面、另一套机制）；不在包里提供 React 反向适配、不在包里提供宿主决策 `decide`（见 §4/§7）。

## 2. 正反向**不共享发射核心**——两个方向最优时机不同

> 设计初稿曾想抽一个共享 `createMeasureLoop` 给两个方向。落地时与 refactor-simulator
> 的生产正向合并，发现这是**错的**：正反向的最优发射时机本就不同，强行共享会让核心
> 长出 by-direction flag。最终采取**正向同步、反向 RAF** 的刻意不对称。

**正向 `createViewAnchor` = 同步发布，不走 RAF。** 原生 overlay 的 `setBounds` 是跨进程、本就晚约 1 合成帧；RAF 再叠一帧 → 拖拽可见拖尾（refactor-simulator 生产验证过的修复）。所以正向在每个 `ResizeObserver` / window `resize` 触发里**同步**测量+发布，抗洪由 `lastPublished` 同值去重承担。撤销安全靠「每次发布开头同步读 `disposed`/`present`」——没有排队帧可跑赢状态变化。正向的 sink 是 IPC→主进程 `setBounds`，**不碰本渲染进程 DOM**，所以同步发布不会形成 RO 重入循环。

**反向 `createSizeAdvertiser` = RAF 合并（内部 `createMeasureLoop`，反向专用）。** 反向是一条**跨进程反馈环**：advertise → 宿主 resize 这块视图 → 下游内容 remeasure → 再 advertise。RAF 的「每帧≤1 次发布」对这条环是合理的阻尼。`createMeasureLoop<T>` 只服务反向，通过注入 `produce`/`same`/`sink` 三元组把方向细节关在外层，核心零 flag：

```ts
function createMeasureLoop<T>(cfg: {
  produce: () => T | null        // RAF 体内取值：读最近一帧 borderBoxSize（null=跳过帧）
  same: (a: T, b: T) => boolean  // 去重谓词（反向 = extent 相等）
  sink: (value: T) => void       // = 注入的 publish
}): { schedule, emitNow, setActive, cancel, dispose }
```

**为什么不对称是对的**：正向是单向跟随者，少一帧直接消除可见拖尾；反向是反馈环，多一帧阻尼更稳。把两者塞进一个核心要么逼出 `if(direction)` flag，要么把正向重新拖回 RAF（复活拖尾）。所以**正向内联同步、反向用 RAF 引擎**，各取所需。

## 3. 反向原语契约

```ts
export type AdvertisedAxis = 'block' | 'inline'

// 帧载荷：纯标量，连「哪条轴」都无从携带 → 单轴在类型层不可拼写。
export interface AdvertisedSize {
  readonly axis: AdvertisedAxis   // 镜像工厂常量，逐帧恒等，供宿主白名单校验
  readonly extent: number         // 主导轴内容尺寸，CSS px，已 round，钳到 >= 0
}

export interface SizeAdvertiserOptions {
  axis: AdvertisedAxis                       // 创建期定死，一个 advertiser 一生只报一条轴
  publish: (size: AdvertisedSize) => void    // 注入；下游接 IPC/postMessage → 宿主（与正向 publish 同名同形）
}

export interface SizeAdvertiserHandle {
  update(opts: SizeAdvertiserOptions): void  // 只能换 publish（换 IPC 通道）；axis 不可变
  dispose(): void                            // 停 observe、取消 RAF，此后永不再 publish
}

export function createSizeAdvertiser(target: HTMLElement, opts: SizeAdvertiserOptions): SizeAdvertiserHandle
```

- 跑在**下游**渲染进程；从 `ResizeObserverEntry.borderBoxSize` 读尺寸（零强制 reflow，**禁**回调内 `getBoundingClientRect`/`scrollHeight`）；上报前 `Math.round` + `Math.max(0, ...)`（与正向 `measure` 的 round/钳零对称）。
- `target` 由调用方选成「主导轴上 shrink-to-fit、不被宿主写入反向决定」的 wrapper（与 `createViewAnchor` 一样，原语不碰调用方 DOM/样式）。
- **没有 `present`**：反向「停止上报」无指令语义（塌缩还是保持是宿主策略），停就 `dispose`、恢复就重建。不给不可信下游一个隐式控宿主的布尔旁路。
- 双轴需求 = **两个独立 advertiser 各管一轴**，不是一个 payload 塞两轴（后者把两条单向流伪装成一条双向流，使 DAG 退化成有环图）。

## 4. 单轴所有权（收敛性地基，不可协商）

- 一个 advertiser 只测量并只上报**它主导的那条轴**；另一条轴由宿主经 `setBounds` 单向灌入、对下游**只读**。
- 为什么收敛：宽 = 宿主输入（无回边）；高 = block layout 的**输出**而非输入（无回边）→ 整条尺寸传播是单向 DAG，**一步收敛**。违反单轴 = 跨进程双 RAF 乒乓，是抖动/极限环根因。去环靠**拓扑**（单轴 + 类型不可拼写），不靠 epsilon 死区/低通滤波。

## 5. 信任边界（精确划线）

> 反向把「尺寸控制权」交给一个**下游控制**（半信任/不可信）的视图。上报值是攻击者输入，不是测量结果。

判据：**凡只需测量上下文的归原语；凡需 viewport/策略/对端身份的归宿主。**

| 责任 | 归属 | 说明 |
|---|---|---|
| `Math.round` 量化 | 原语 | 测量副产物，出生地最便宜 |
| 丢 `NaN`/`Infinity` | 原语 | 测量噪声，不该塞进 IPC |
| 负值 → **钳到 0**（非丢弃） | 原语 | 与正向 `Math.max(0,...)` 对称；钳零＝诚实上报「现在测出来是 0」，丢弃会让宿主停在过期值 |
| 限流 | **两边都不额外加** | 原语的 RAF 合并 + 去重已是终极限流（跟随刷新率、静止零发）；宿主用 clamp + `decide` 幂等吸收突发，**不做时间节流**（会吞掉合法离散事件） |
| `clamp(min, max)` | 宿主 | 唯一持有 viewport/available/策略的一方；对抗恶意巨值的**主防线** |
| 来源校验（senderFrame/origin/token） | 宿主 | 只能发生在收 IPC 那一刻 |
| 白名单轴 | 宿主 | 用 payload 的 `axis` 常量比对，`axis !== expected` 则丢弃 |
| 位置 / 另一轴 / z-order 锁定 | 宿主 | 下游无任何途径改变 → 杜绝全窗覆盖类点击劫持 |

**target 选错（反馈环）的防护——克制为主，不过度防御。** 关键事实：违反单轴所有权时，RAF 合并把「死循环」**封顶为每帧一次**——它退化成可见的抖动 / 每帧一次冗余 IPC，而**不是冻死 UI**。既然不是灾难性故障，就不值得为它在每帧路径上堆检测器。最终只保留：

- **一条构造期廉价守卫**：`target` 是 `<body>`/`<html>` 时 `console.warn`——这是「stable-but-wrong」（占位永远撑成视图高、不缩到内容）最常见的成因，一次性、零每帧成本。
- **其余靠文档**：JSDoc 与本节把「target 必须主导轴 shrink-to-fit、不被宿主灌入的尺寸反向决定」讲清。
- **明确不做**：每帧的 2-cycle / 单调发散检测器（复杂度与「非灾难性、RAF 封顶」的故障不成正比）、运行时熔断（会把可见症状盖成静默失效）、向宿主回传灌入值做对比（会亲手造出 §4 要消灭的反馈边）。发散的真正兜底是宿主侧 `clamp(max)`。

## 6. 两个原语如何「锚」到一起

正向与反向**不直接相互调用**——各自只有一个注入的 `publish` 往 IPC 上发。把两端串到一起的是宿主里的**占位 div** + 宿主的 `decide` 函数。占位 div 是会合点（join point）：

- **`createSizeAdvertiser` 写**占位 div 的尺寸（经宿主）——内容多高，占位就多高。
- **`createViewAnchor` 读**占位 div 的矩形——占位在哪、多大，原生视图就贴哪、多大。

即：反向喂占位的「一条轴的大小」，正向把占位的「完整矩形」投到原生视图上。占位 div 是几何的**唯一真相**，两端都围着它转。

### 闭环（以 toolbar 为例）

```
宿主渲染进程                          宿主主进程           下游渲染进程（toolbar 自己的页面）
──────────                          ────────            ────────────────────────────
[占位 div]                                               [内容 wrapper（shrink-to-fit）]
  │ ▲                                                      │
  │ │ ② decide 把高写进占位 div                             │ ① createSizeAdvertiser
  │ │    div.style.height = clamp(size.extent)             │    量 wrapper 的 block-size
  │ └─────────── IPC ◀─────────────────────────────────────┘    publish(size) ──▶
  │
  │ ③ 占位 div 尺寸变 → createViewAnchor 的 ResizeObserver 触发
  │    量占位新矩形 → publish(bounds)
  ▼
  ──── IPC ──▶ ④ view.setBounds(bounds) ──▶ [WebContentsView（这块 toolbar）]
                                               │ 视图变 → 下游 viewport 变 → 内容重新布局
                                               └──▶ 回到 ① advertiser 再量（收敛）
```

1. **下游**：`createSizeAdvertiser(wrapper, { axis:'block', publish })` 量内容高 → IPC 发回宿主。
2. **宿主**：纯函数 `decide(size, { axis, min, max, available })` 夹一夹，把结果写进**占位 div 的高**（`div.style.height = …`）。
3. **宿主**：占位 div 高一变，`createViewAnchor` 挂在它上的 `ResizeObserver` 立刻触发 → 量出占位新矩形（宽 = 宿主布局给的满宽，高 = 刚写进去的内容高）→ `publish(bounds)`。
4. **宿主主进程**：`view.setBounds(bounds)` → toolbar 这块 `WebContentsView` 变成新尺寸 → 下游 viewport 变 → 内容重新布局 → 回到 ①。

### 谁负责什么

| 角色 | 谁提供 | 在 view-anchor 里？ |
|---|---|---|
| `createSizeAdvertiser`（量内容 → 发 size） | view-anchor | ✅ |
| `createViewAnchor`（量占位 → 发 bounds） | view-anchor | ✅ |
| `decide`（把 size 写进占位 div 的高）+ 两条 IPC 通道 | **宿主（workbench）** | ❌（刻意，属宿主胶水） |
| 占位 div、shrink-to-fit wrapper | 调用方的 DOM | ❌ |

- 收敛逻辑收进宿主一个**纯函数** `decide(...)`（可单测、无跨进程协议）。`decide` 住宿主侧，**不进 view-anchor**——包只出两个单向原语，不出收敛策略，否则就从原语滑向框架（§8）。
- 连续交互（拖窗改宽）走宿主**单向**路径，不进闭环；反向只服务下游内容的**离散**尺寸变化。

## 7. 与 Electron preferred-size 的关系（宿主侧可选数据源，非替代）

宿主若在 Electron 且能接受零下游代码，可用 `enablePreferredSizeMode` + `preferred-size-changed` 作为反向「**源**」喂给同一个 `decide`，省掉下游注入。但它是 Electron 私有、且有两点待 spike 坐实：① 在 `WebContentsView` 上触发且上报值吸收 zoom；② `setBounds.height` 不回灌 layout（否则正反馈震荡）。

view-anchor 的反向原语是**引擎无关/可移植**那条路（非 Electron / iframe 宿主、需选子 target 的场景）。两者并存：preferred-size 是 Electron 捷径，advertiser 是可移植机制，`decide` + §5 安全红线是二者共用的公共底座。这也是反向逻辑该留在 view-anchor、而非写死成 Electron 事件的理由。spike 结果只决定宿主选哪个**源**，不改变 view-anchor 要不要建反向原语。

## 8. 包定位守恒（仍是一个原语，不是框架）

双向化后 view-anchor 仍是「DOM 几何 ↔ 跨进程视图」的**单一职责双向桥**。守住四条即不滑向框架：① 导出面只多 `createSizeAdvertiser` + 其类型；② `createMeasureLoop` 不导出；③ 现在不做 React 反向适配（下游不保证是 React）；④ `decide` 留宿主、不进包。

## 9. 已收敛 / 仍待拍板

已由对抗评审定：payload 单标量 `{axis, extent}`（关闭「单标量 vs 可空双轴」）；命名 `createSizeAdvertiser`/`AdvertisedSize`/`publish`（关闭命名问题）；`present` 砍掉。
仍待定：React 反向适配 `useSizeAdvertiser` 是否要做（默认否，等出现真实 React 下游）。
