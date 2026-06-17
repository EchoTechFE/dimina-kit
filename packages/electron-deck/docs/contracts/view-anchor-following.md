# view-anchor 跟随契约硬化（split / nested / tab 的几何地基）

> 本页定义 `@dimina-kit/view-anchor` 正向锚（`createViewAnchor` / `createPlacementAnchor` /
> `useViewAnchor`）让原生 `WebContentsView` **跟随任意 DOM slot** 所需的观测面与时序契约：
> 哪些位移信号必须被观测、各自怎么观测、可见性归谁、首帧与终止如何保证。落点在
> `packages/view-anchor/src/{view-anchor,react,types}.ts`。
>
> 为什么这份文档住 `electron-deck/`：跟随的「为什么必须做实」由 host-shell 的
> split/nested/tab 需求驱动（electron-deck 是 host），而「**怎么做实**」是 view-anchor
> 这条原语的契约。两包之间的 seam = 注入的 `publish`，所以契约在 host 侧立、原语侧实现。

---

## 0. 默认观测面（关闭 opt-in 时）

不开任何 opt-in option 时，正向锚只观测**两类信号**：

```ts
observer = new ResizeObserver(emit)   // ① target 自身 border-box 变化
observer.observe(target)
window.addEventListener('resize', emit) // ② 整窗 resize
```

这把「target 的屏幕矩形会变」**等同于**「target 自己的尺寸会变」。这个等式在**单一固定面板**里成立（simulator / debug 占位即如此：占位是 flex:1 的直接子，矩形只随容器尺寸变）。一旦 slot 嵌进 split / nested / tab，等式破裂——矩形会因为**祖先**的动作而变，target 自己尺寸却纹丝不动，ResizeObserver 测不到，原生 view 当场跟丢。

`useViewAnchor` 的 `deps`（`react.ts`）让调用方把「会移动矩形但 DOM 看不见的状态」塞进数组强制 re-publish。但这要求调用方**预先枚举每一种会移动矩形的状态**——对一个能放进任意 split/tab 的 slot，这不可能预先枚举（外层 splitter 是谁、有几层、在不在可滚动容器里，slot 自己都不知道）。所以「跟随任意 slot」不能靠 `deps`，必须由锚**自己**把观测面补全——这是下面 §2 的 opt-in option（`followScroll` / `followGeometry` / `guardDisplayNone`）做的事。

---

## 1. 六类位移信号（及各自修法）

| # | 信号 | 默认为何测不到 | 修法（§见） |
|---|---|---|---|
| 1 | **祖先移动**（嵌套 split 外层 splitter 拖动） | 内层 slot 尺寸没变 → RO 不触发；window 没 resize → resize 不触发 | RAF 几何哨兵（§2.D） |
| 2 | **scroll**（slot 在可滚动容器里滚动） | 滚动改的是位置不是尺寸，RO 盲；scroll 不冒泡到 window 的 resize | 祖先 scroll 捕获监听 + RAF 哨兵（§2.C/D） |
| 3 | **CSS transform**（祖先 transform / translate 动画） | 屏幕位置变、`getBoundingClientRect` 的 left/top 跟着变，但**没有任何 DOM 事件**通告 | RAF 几何哨兵（§2.D）——这是 RAF 不可替代的核心理由 |
| 4 | **`display:none`**（tab 用 display 隐藏） | slot 从渲染树消失，`getBoundingClientRect` 返回全 0 → 被当成「移到 (0,0) 且 0×0」，原生 view 残留/闪到角落 | IntersectionObserver 判可见性 + 几何守卫（§3） |
| 5 | **slot 未 mount / 首帧 layout 未稳** | 同步 measure 拿到 0 矩形或脏矩形 → 原生 view 闪在 (0,0) | 首帧守卫（§4） |
| 6 | **销毁不发终止 hidden** | 核心 `dispose()` 只停观察、刻意不再发布；slot 卸载后宿主收不到 hidden → 原生 view 冻在最后矩形 | 终止性 hidden（§5） |

总策略：**保留正向「同步发布」的不可动摇内核**（§7 论证为何不能整包搬去 RAF），只在它之外**叠加**一组观测器，每个观测器的回调仍走现有的同步 `emit()`。

---

## 2. 观测面扩展：最小够用且不抖的组合

### 设计判据

「跟随任意 slot」= 凡是会改变 `target.getBoundingClientRect()` 屏幕矩形的信号，锚都要能重新 measure+publish。把信号按「能否被某个 DOM 事件/Observer 精确通告」分两类：

- **可被事件精确通告的**（A/B/C）：自身尺寸、整窗 resize、祖先 scroll。→ **事件驱动**，零空转。
- **无任何事件通告的**（D）：祖先 transform、祖先因兄弟变化而**重排导致的位移**、以及一切「我尺寸没变但我被推走了」。→ 只能**轮询** `getBoundingClientRect` 比对。

最小组合 = **A+B+C 事件驱动兜住绝大多数 + D 的 RAF 哨兵只在「有理由怀疑在动」时启动**。关键：**RAF 不常驻**，由交互窗口 gating（§2.D + §6），静止时零成本。

### A. ResizeObserver（默认开）

`observer.observe(target)` —— target 自身 border-box 变化。与 `display:none`（RO 不触发、IO 触发）的协同见 §2.E。

### B. window `resize`（默认开）

整窗尺寸变。

### C. 祖先 scroll 监听（`followScroll`，事件驱动）

slot 落在可滚动容器里滚动时，`scroll` 事件**不冒泡**到 window。修法：在 **捕获阶段**于 `window` 上挂一个 `scroll` 监听，`{ capture: true, passive: true }`：

```ts
window.addEventListener('scroll', onAncestorScroll, { capture: true, passive: true })
```

- **为什么捕获阶段挂 window**：`scroll` 不冒泡，但**会**在捕获阶段从 window 往下传到目标滚动容器。在 window 捕获即可收到页面内**任意**滚动容器的滚动，无需遍历 target 的祖先链逐个 `addEventListener`（祖先链是动态的，slot 不该知道自己嵌在谁里）。
- **passive**：纯读，不 `preventDefault`，让浏览器滚动不被阻塞。
- **回调**：scroll 是连续高频信号。`followGeometry` 关时，scroll 回调做一次同步 `emit()`；`followGeometry` 开时，scroll **打开 §2.D 的 RAF 哨兵窗口**（滚动期间每帧测一次，停了就关），与 D 共用同一个「交互期每帧测、静止零测」的机制，避免两套节流。

### D. RAF 几何哨兵（`followGeometry`，**非常驻**，是 transform/祖先移动唯一兜底）

transform 和「祖先重排把我推走」**没有任何事件**。dockview 的 `OverlayRenderContainer` 用常驻 RAF 每帧 `getBoundingClientRect` 重测来兜这一类——本锚的哨兵不照搬常驻（§7 成本论证），而是窗口化：

```
RAF 哨兵 = 一个「窗口化」的 requestAnimationFrame 轮询：
  - 每帧 measure(target) → 与 lastPublished 比 → 不同才 emit（复用现有同步 emit+dedup）
  - 何时启动（开窗）：见 §6 的「交互窗口」gating
  - 何时停止（关窗）：连续 N 帧（建议 N=2~3，真机调）测出矩形与上帧逐字段相等 → 判定静止 → cancelAnimationFrame
```

哨兵**只在「有理由相信几何在动」时存活**：
- 触发开窗的信号：祖先 scroll（§2.C）、`pointerdown` 命中页面内任意 `[role="separator"]`/splitter（拖动开始）、以及调用方经 `pulse()` 显式声明的「动画期」（§2.F）。
- 自动关窗：检测到连续静止帧。所以一次 splitter 拖动 = 开窗→拖动中每帧跟随→松手后 2~3 帧内判静止→关窗，**拖完即零成本**。

> 为什么不直接每帧测就好、还要 dedup 关窗：见 §7。一句话——常驻 RAF 对「同时存在 N 个锚、其中大多数静止」的多面板场景是纯浪费；窗口化把成本压到只在真正交互的那个锚上。

### E. IntersectionObserver（`guardDisplayNone`，**仅供可见性几何**，不抢调用方意图）

见 §3：IO 负责回答「target 是否**几何上**在视口里有非零可见面积 / 是否被 `display:none`」，**不**负责「调用方想不想显示它」。职责切分见 §3 表。

### F. 显式动画提示（`pulse()`）

某些位移由 CSS transition/animation 驱动（tab 切换的滑入、面板展开动画），既非 scroll 也非 splitter 拖动。`pulse()` 让调用方**临时开窗**：

```ts
handle.pulse(durationMs?: number)   // 命令式核心：开 RAF 哨兵窗口，durationMs 后或判静止后自动关
```

与 `deps` 的区别：`deps` 是「立刻重发一次」（一帧），`pulse` 是「接下来一段时间每帧跟随」（动画全程）。调用方只需知道「现在开始有动画」这一个事实，不需要枚举动画把矩形挪到哪。`pulse()` 在 `followGeometry` 关时为 no-op。

### 观测组合总表

| 信号 | 观测器 | 驱动 | 常驻？ |
|---|---|---|---|
| target 自身尺寸 | ResizeObserver | 事件 | 是（但静止零回调） |
| 整窗 resize | window `resize` | 事件 | 是（静止零回调） |
| 祖先 scroll | window capture `scroll`（`followScroll`） | 事件 → 开 RAF 窗 | 是（静止零回调） |
| 祖先 transform / 重排位移 | **RAF 几何哨兵**（`followGeometry`） | 轮询 | **否**（窗口化） |
| display:none / 出视口 | IntersectionObserver（`guardDisplayNone`） | 事件 | 是（静止零回调） |
| 动画期位移 | `pulse()` → RAF 窗 | 调用方提示 | 否（窗口化） |

---

## 3. 可见性来源：几何 vs 调用方意图（精确划线）

`createPlacementAnchor` 的 `{ visible:false }` **纯粹是调用方意图**（`present` 标志）——锚自己绝不从几何推断隐藏（`measurePlacement` 永远返回 `visible:true`，「hiddenness is a caller decision」）。这个设计是对的，IO **不**去翻它。划线如下：

| 维度 | 谁说了算 | 机制 | 失败模式（若搞错） |
|---|---|---|---|
| **意图**：这块 view **应不应该**在屏上（tab 切走、面板手动收起） | **调用方** | `present:false` 等显隐 API | 若让 IO 接管 → 用户滚动让 slot 暂时滚出视口，view 被「自作主张」detach，滚回来又 attach，闪烁 + 跨进程抖动 |
| **几何**：target 此刻**在不在 DOM、有没有非零屏幕矩形、是不是 `display:none`** | **锚（IO + measure）** | IntersectionObserver + `getBoundingClientRect` 全 0 检测 | 若让调用方负责 → tab 用 `display:none` 隐藏时调用方忘了发意图，view 残留在原位（信号 #4） |

**职责边界**：

1. **显隐意图永远是调用方说了算**。tab 切换 = 调用方对被切走的 slot 显式发意图 `present:false`（或 electron-deck 的 tab 容器统一替成员 slot 发）。锚**不**用 IO 把「滚出视口」翻译成 `visible:false`——那会把「暂时不可见」误判成「意图隐藏」。

2. **IO 只补一件事：几何兜底，防 `display:none` 残留**。当 target 进入 `display:none`（IO 报 `isIntersecting:false` 且 `intersectionRect` 全 0，且 `boundingClientRect` 也全 0），锚发一条 **`{ visible:false }`（detach，不带 bounds）**——**不是** 0 尺寸的 `visible:true`。理由：
   - `display:none` / slot 无任何几何盒 = **没有可锚的几何**，这是一个**客观事实**，不是「调用方改了显隐意图」。Placement 的判别式（`types.ts`）把 `{ visible:true, bounds:0×0 }`（元素在、但渲染成 0×0 的**合法罕见**情形）与 `{ visible:false }`（无几何盒 / 隐藏，**不带 bounds**）钉成**必须可区分**的两态——这正是消「魔法 0」的核心。`display:none` 没有几何盒，归后者，**不能**伪装成 0×0 的 visible（那会把「客观无盒」与「合法 0×0 元素」重新混成一谈，复活魔法 0）。
   - 宿主侧把 `{ visible:false }` 读作「detach but keep alive」：原生 view 被摘下但 WebContents 存活，`display` 恢复（IO 再报有交集 / measure 拿到非零盒）时瞬时贴回。
   - **这不算「IO 篡改调用方意图」**：`visible:false` 的语义是「**不显示这个 view**」，而「不显示」由**两路 OR** 得出——调用方意图 hide（`present:false`）**或** 锚测出无几何盒（`display:none` / 未 mount）。IO 报告的是后一路（客观事实），与前一路（调用方意图）做 **OR**，不覆盖、不翻转调用方的意图位；只要任一路为「不显示」，最终就 `visible:false`。所以这与「锚不替调用方决定意图」不冲突——「无几何可锚」不是一个意图，是一个事实，事实与意图 OR 进同一个 `visible:false` 终态。

   > **与 `{visible:true, bounds:0×0}` 的边界**：后者**只**保留给「元素仍在渲染树、有几何盒，但被排版成 0×0」这一**合法罕见**情形（例如内容真的塌成 0 高）。`display:none` / 未 mount / 无几何盒 一律走 `{visible:false}`。判别口诀：**有盒但 0 面积 → visible:true+0×0；无盒 → visible:false**。
   >
   > 对 legacy 的 `createViewAnchor`（`Bounds` 而非 `Placement`，无判别式）：`display:none` 时 measure 本就返回全 0，等价于发 ZERO（detach），行为已对；但它**不知道何时该重测**——靠 §2 的 IO/RAF 触发补这一步。Placement 版的好处正是显式区分了「合法 0×0 visible」和「无几何盒 → visible:false」，这正是 split/tab 场景需要、且 legacy ZERO 约定表达不出来的精度。

3. **一句话边界**：**「想不想显示」是意图（调用方）；「现在贴得上贴不上、贴在哪」是几何（锚）。** 锚永远不替调用方决定意图；调用方永远不该手算几何。

---

## 4. 首帧守卫（防原生 view 闪 (0,0)）

信号 #5：slot 还没进 DOM、或刚进但 layout 未稳时，同步 measure 报出脏/0 矩形，原生 view 闪在 (0,0)。契约：

**「首个有效矩形之前，绝不 publish 一个会让原生 view 出现在错误位置的矩形。」**

具体规则（落在 `apply()` 的初次发布与 IO 首帧）：

1. **判「无效矩形」**：`width===0 || height===0`（含未 mount 的全 0、`display:none` 的全 0、layout 未稳的塌缩）。
2. **首帧若无效 → 不发非零、改发 detach 信号**：
   - Placement 版：发 **`{ visible:false }`**（detach，不带 bounds；§3.2 同款，未 mount / 全 0 = 无几何盒），**绝不**发非零 bounds、也**不**发 0 尺寸的 `visible:true`。
   - legacy `Bounds` 版：发 `{0,0,0,0}`（ZERO），等价 detach。
3. **挂 IO + RAF 哨兵等第一个非零矩形**：IO 的 `isIntersecting` 转 true（或哨兵某帧测到非零 width/height）即触发一次正常 `emit()` → 发首个真实矩形 → 原生 view **直接出现在正确位置**，从无闪 (0,0)。
4. **不发非零 (0,0)**：(0,0) 作为**位置**是合法的（slot 真在左上角），所以不能用「位置==0」判无效；判据只用 **尺寸==0**（与 `clampRect` 的 width/height 钳零、x/y 不钳零的不变量一致）。

> 取舍：「首帧直接不 publish 任何东西，静默到第一个有效矩形」也能防闪，但会让宿主侧的 view 处于「创建了但从没收到过 placement」的未定义初态。发一帧 `{ visible:false }`（detach-but-keep）让宿主从一开始就处于明确的 detached 态，恢复时只是一次 attach，时序更干净 → **发 visible:false detach**。

---

## 5. 终止性 hidden（dispose / 卸载必须发 detach，防残留）

信号 #6：核心 `dispose()` 刻意只停观察、**永不再发布**。这对「调用方会先发 ZERO 再 dispose」的用法成立——但跟随任意 slot 时，slot 可能在调用方来不及发 detach 之前就被 React 卸载。契约：

**「锚的生命终点（dispose）或 slot 卸载，必须有且仅有一条终止性 detach 信号抵达宿主，让原生 view 被摘除——不依赖调用方记得先发。」**

落点分两层（核心保持纯净、把补发放适配层）：

- **核心 `createViewAnchor.dispose()` / `createPlacementAnchor.dispose()`**：**不**自动补发（保持「dispose 后静默」不变量；core 不知道宿主的 detach 协议是 ZERO 还是 `{visible:false}`，由 sink 语义决定，不该在 core 写死）。
- **React 适配层 `useViewAnchor`**：`collapseAndDispose`（`react.ts`）—— `ref → null` / 卸载时先 `update({ present:false })`（发 ZERO/detach）再 `dispose()`。这是「任意 slot 的硬契约」：
  - `ref(null)`（元素 detach）→ 必发一条 detach 再 dispose。
  - 组件卸载（`elRef.current===null` 的 cleanup）→ 必发一条 detach。
  - **命令式直接用 `createPlacementAnchor` 时**（无 React 适配层）：调用方必须在 `dispose()` 前发 `{ visible:false }`——这在 `createPlacementAnchor` 的 JSDoc 用 **FOOTGUN** 标注（与 size-advertiser 的 `<body>` 守卫同风格），因为命令式核心刻意不补发。

**为什么不让核心自动补发**：核心服务两种 sink（ZERO 约定 / Placement 约定），终止信号的**形状**取决于 sink 语义，core 写死任一种都会对另一种错。补发的归属 = **知道 sink 语义的那一层**（React 适配层知道是 ZERO；命令式调用方知道自己用的是哪种）。所以契约是「**终止 detach 必达**」，实现位置随 sink 语义层走，core 维持静默不变量。

---

## 6. 性能 / 抖动：多锚 + RAF 的成本与收敛

### 成本模型

设页面同时有 N 个锚（N 个 split 叶子各一块原生 view）。各信号成本：

| 信号 | 静止态成本 | 交互态成本 |
|---|---|---|
| ResizeObserver ×N | 0 回调 | 仅尺寸真变的那个锚触发 |
| window resize | 0 | 整窗拖动期间所有 N 个一起重测（本就该全测，合理） |
| capture scroll | 0 | 仅滚动期间，开对应锚的 RAF 窗 |
| **RAF 哨兵** | **0（窗口关闭）** | **仅「正在动」的锚开窗**——通常是被拖的那 1 个，不是 N 个 |
| IntersectionObserver ×N | 0 回调 | 仅可见性翻转时触发 |

**核心论点**：把 RAF **窗口化**（§2.D）而非常驻，使静止态成本严格为 0，交互态成本正比于「正在动的锚数」而非 N。dockview 常驻 RAF 是「单一 overlay 容器」语境下可接受的简化；本锚是「N 个独立锚」语境，常驻会让 N 个锚每帧各测一次 `getBoundingClientRect`（N 次强制布局读），**即使只有一个在动**——这是必须窗口化的原因。

### dedup / coalesce

- **同值去重**（`lastPublished` + `sameRect` / `samePlacement`）：一次连续拖拽里每个不同矩形至多发一次 IPC；RAF 哨兵每帧测到相同矩形直接丢，**不发 IPC**。这也是哨兵「连续静止帧 → 关窗」（§2.D）的判据来源——dedup 命中即静止信号。
- **同帧多信号合并**：scroll + RAF 哨兵共用同一个「每帧测一次」的 RAF 体，一帧内 scroll 触发多次也只测一次。ResizeObserver/resize 的同步 `emit` 与 RAF 体之间靠 `lastPublished` 去重防重复发。
- **不加时间节流**：与 size-advertiser 同立场——RAF 跟随刷新率已是终极限流，额外 throttle 会吞掉合法的离散位移。

### 抖动来源与封堵

- 唯一会抖的是「IO 把滚出视口误判成意图隐藏」——§3 已封死（IO 不动意图）。
- 哨兵关窗用「连续 N 帧静止」而非「1 帧静止」，避免拖动中的瞬时停顿（手指悬停）误判关窗后又被下一帧位移重新开窗的开关抖动。N=2~3 待真机定。

---

## 7. 为什么不整包搬去 RAF（与「禁 RAF」测试的调和）

强约束：`view-anchor.test.ts` 断言正向锚**事件驱动路径「never schedules a requestAnimationFrame」**。理由：正向 sink 是跨进程 `setBounds`，本就晚约 1 合成帧，RAF 再叠一帧 → 拖拽可见拖尾（GROWING 时露背景最明显）。这条不变量保留。

调和方式——**区分两类触发的发布时机**：

1. **事件驱动触发**（RO / resize / scroll-induced 的「我知道刚发生了一次离散变化」）：**同步发布**，不进 RAF。信号 #1/#2 中「事件能精确通告」的部分走这条，无新增帧。
2. **轮询触发**（RAF 几何哨兵，信号 #1 祖先移动 / #3 transform 的「无事件、只能每帧问一次」）：**本质上就是每帧轮询**，RAF 是它**唯一**的实现方式——这不是「把同步发布推迟一帧」，而是「在没有事件的情况下，每帧主动 measure 一次」。哨兵在 RAF 体内**测到变化就同步发**（当帧 measure+publish，不再往后推一帧），所以它**不引入**「发布晚一帧」的拖尾——它引入的只是「**发现**变化最晚晚一帧」（轮询固有，无事件就只能下一帧才知道）。

因此「禁 RAF」测试的精确含义是：**事件驱动路径不得 RAF-defer 其发布**——而不是「整个包不许出现 requestAnimationFrame」。哨兵的 RAF 属于**轮询机制**，不是**发布延迟**。

> 一句话：**事件能告诉你的，同步发；事件告诉不了你的（transform/祖先移动），每帧轮询、当帧发。** 两者都没有「为了合并而推迟发布」的那一帧——拖尾的根因被保留封死。

---

## 8. 嵌套 split 场景演示（证明观测组合够用）

场景：**左 | 右 分；右侧再 上 / 下 分；原生 view 在右下叶子；拖外层（左|右）splitter。**

```
┌───────────────┬─────────────────────────┐
│               │  右上 (叶子，无原生 view)  │
│   左 (叶子)    ├─────────────────────────┤
│               │  右下 (叶子)              │
│               │   └─ [占位 div] ← 锚      │  ← 原生 WCV 贴这里
└───────────────┴─────────────────────────┘
        ▲ 拖这条外层 splitter（左|右）向右
```

拖外层 splitter 向右：

1. 左叶子变窄、右半边整体变宽并**左移**。右下占位 div 的 **width 变了**（右半边变宽）→ **ResizeObserver 触发**（§2.A）→ 同步 emit → 新矩形（宽变、x 也左移了）→ publish。✅ 宽度变化这一维**事件能告诉你**，同步发，无拖尾。

考虑**纯左移不变宽**的退化变体（外层 splitter 在右半边内部、或右半边是固定宽时整体被推走）：占位 div 的 **width/height 都没变、只有 x 变**（祖先把它整体推走）。此时：

2. ResizeObserver **不触发**（尺寸没变）——这正是信号 #1。
3. 拖动从 splitter 的 `pointerdown` 开始 → §2.D/§6 的「命中 `[role="separator"]` 开窗」启动 **RAF 哨兵** → 拖动中每帧 measure 占位 div → x 每帧在变 → 与 lastPublished 不同 → 当帧同步 publish 新 x。✅ 原生 view 跟随左移，逐帧贴住。
4. 松手 → 占位 div 稳定 → 哨兵连续 N 帧测到相同矩形 → 关窗 → 回到零成本静止态。

再叠 **scroll 变体**：若右下叶子是可滚动容器、原生 view 占位随内容滚动：

5. 滚动 → `scroll` 不冒泡到 window，但 **window 捕获阶段**收到（§2.C）→ 开 RAF 窗 → 滚动期间每帧测占位新 y → publish。✅ 滚动跟随。停滚 → 判静止 → 关窗。

再叠 **transform 变体**（外层 split 用 CSS transform 做展开动画而非改 flex 尺寸）：

6. transform 改屏幕位置、`getBoundingClientRect` 的 left/top 变、但**无任何事件**。调用方在动画开始时 `pulse()`（§2.F）→ 开 RAF 窗 → 动画全程每帧跟随 → 动画结束判静止关窗。✅。

**结论**：A（宽高变）+ C（滚动）+ D（splitter/transform 引发的纯位移）+ F（动画）覆盖了嵌套 split 下原生 view 会经历的全部位移来源。每一类都有对应触发，且静止后全部回到零成本。

---

## 9. 跨进程时序：拖动滞后（真机定）

publish → IPC → 主进程 `setBounds` 有不可消除的延迟。锚做到「发现变化的当帧就同步 publish」（§7），但 IPC + 主进程合成仍使原生 view 比渲染进程 DOM **晚约 1 合成帧**到位（已接受的现状——靠占位/desk 背景同色遮掩边缘露出）。

跟随契约**新引入**的潜在滞后只有一处：**RAF 哨兵的「轮询发现延迟」**——transform/祖先移动这类无事件信号，最坏情况「变化发生」到「哨兵下一帧测到」差 1 帧，再叠固有的 1 跨进程帧 = 拖动这类信号时原生 view 最坏滞后 DOM **2 帧**（事件驱动信号仍是 1 帧）。

取舍（真机定）：

- **默认接受 2 帧**：拖动是用户主动、低速、背景同色遮掩，2 帧（~33ms@60Hz）大概率不可见。先不做预测/插值——插值要在主进程对 bounds 做外推，复杂且可能过冲（松手瞬间外推冲过头更难看）。
- **待真机验证点**：
  1. **RAF 哨兵常驻 vs 窗口化的成本差**在真机多锚下到底多大——若窗口化的开关逻辑本身开销接近常驻，则简化为常驻；§7 的窗口化论证是纸面推导。
  2. **拖动 2 帧滞后是否可见**——若可见，再评估是否需要只对哨兵维度（位移）做主进程外推；外推 vs 接受滞后只能真机看。
  3. **哨兵关窗的 N 帧静止阈值**（N=2~3）——太小则手指悬停误关、太大则松手后多空转几帧。
  4. **capture scroll 监听在深嵌套滚动容器下是否真能收到全部滚动**——理论上捕获阶段必达，但被动 listener + 浏览器滚动合成线程的实际触发时机需实测确认不丢帧。

---

## 10. API 总览

> 全部是**叠加**，不破坏现有签名；不开 option 即退化成「自身尺寸 + 整窗 resize」的默认行为。

### `createPlacementAnchor`（Placement 命令式核心）

follow option（默认全关）与 `pulse` 落在 Placement 变体（`PlacementAnchorOptions` / `PlacementAnchorHandle`）：

```ts
interface PlacementAnchorOptions {
  // ...present / publish...
  /** 追加祖先 scroll 跟随（window 捕获阶段监听）。默认 false。 */
  followScroll?: boolean
  /** 启用 RAF 几何哨兵（兜 transform / 祖先移动）。默认 false。
   *  开窗由 scroll / splitter pointerdown / pulse() 触发，静止自动关窗。 */
  followGeometry?: boolean
  /** display:none 兜底：挂 IntersectionObserver，进入 display:none（无几何盒）时
   *  发 `{ visible:false }`（detach-but-keep，不带 bounds），恢复时重测。默认 false。 */
  guardDisplayNone?: boolean
}

interface PlacementAnchorHandle {
  update(opts: PlacementAnchorOptions): void
  dispose(): void
  /** 开一次 RAF 哨兵窗口（动画期跟随）；durationMs 后或判静止后自动关。
   *  followGeometry 为 false 时为 no-op。 */
  pulse(durationMs?: number): void
}
```

### `createViewAnchor`（legacy Bounds 核心）

`createViewAnchor` / `ViewAnchorHandle` 维持 `present` / `publish` / `update` / `dispose` 的原形态，**不带** follow option 与 `pulse`——split/tab 跟随走 Placement 变体。`display:none` 时它 measure 返回全 0、发 ZERO（detach），但缺判别式区分「合法 0×0」与「无几何盒」，故新场景用 `createPlacementAnchor`。

### `useViewAnchor`（React 适配层）

```ts
interface UseViewAnchorOptions extends ViewAnchorOptions {
  deps?: ReadonlyArray<unknown>   // 非 DOM 依赖变化 → 强制 re-publish 一次
}
```

- 终止性 detach（§5）由 `collapseAndDispose` 覆盖（`ref→null` / 卸载发一条 detach 再 dispose）。
- `useViewAnchor` 走 legacy `ViewAnchorOptions`（`present`/`publish`/`deps`）；要 split/tab 跟随 option 与 `pulse` 时直接用 `createPlacementAnchor`。

### `electron-deck` 侧（host 胶水，不进 view-anchor）

- split 的每个叶子占位 div 用 Placement 锚开 `followScroll` / `followGeometry` / `guardDisplayNone`。
- splitter 组件在 `pointerdown` 时通知其管辖叶子的锚 `pulse()`（或锚自身的 capture `pointerdown` 命中 `[role="separator"]` 自动开窗——倾向后者更自治，真机定）。
- tab 容器切换时对非活动成员发意图 `present:false`，对活动成员 `present:true`。

---

## 11. 契约小结（锚保证 / 不保证）

**保证跟随的信号**：
1. target 自身尺寸变化（RO，同步发）。
2. 整窗 resize（同步发）。
3. 祖先滚动（`followScroll`，window 捕获 scroll，开窗逐帧跟）。
4. 祖先 transform / 祖先重排导致的纯位移（`followGeometry` RAF 哨兵，开窗逐帧跟）。
5. 动画期位移（`pulse()` 开窗）。
6. `display:none` 隐藏（`guardDisplayNone` IO）→ 发 `{ visible:false }`（detach-but-keep，无几何盒），恢复重测、瞬时贴回。
7. 首帧未 mount / layout 未稳 → 不发非零脏矩形，发 `{ visible:false }` detach，等首个有效矩形（§4）。
8. dispose / 卸载 → 终止性 detach 必达（§5，由知道 sink 语义的那层补发）。

**不保证 / 明确不做**：
- **不替调用方决定显隐意图**：滚出视口 ≠ 意图隐藏，锚绝不据此 detach（§3）。
- **不消除跨进程固有 1 帧滞后**（已接受，背景同色遮掩）；轮询信号再叠 1 帧轮询发现延迟（§9，真机定是否需外推）。
- **不常驻 RAF**：静止态严格零轮询成本（§2.D / §6）。
- **不在包里做时间节流**（dedup + RAF 跟随刷新率已是终极限流）。
- **不在核心 dispose 后自动补发**（终止 detach 的形状随 sink 语义，归适配层/调用方，§5）。
- **不提供 `decide` / 收敛策略 / tab 容器**（host 胶水，留 electron-deck）。

---

## 12. 最不确定、必须真机证的点

1. **RAF 哨兵成本（窗口化 vs 常驻）**：多锚静止场景下窗口化是否真把成本压到 ~0、开关逻辑本身是否反而比常驻还贵（§6 / §9）——纸面推导，未实测。
2. **拖动 2 帧滞后是否可见**：可见则需评估对位移维度做主进程外推 vs 接受滞后（§9）。
3. **哨兵关窗 N 帧阈值**（N=2~3）：手指悬停误关 vs 松手空转的平衡（§9）。
4. **capture scroll 在深嵌套滚动容器是否不丢帧**（§9）。
5. **splitter 开窗机制**：锚自身 capture `pointerdown` 命中 `[role="separator"]` 自动开窗 vs splitter 显式 `pulse()`——哪个更不漏触发，真机定（§10）。
