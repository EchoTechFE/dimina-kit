# Claude Code Adapter

- worktree、submodule、native-host/compiler 构建和 e2e 环境问题使用 `dimina-kit-worktree-build` skill。
- 微信/官方语义核验使用 `upstream-semantics`；状态机、导航、异步和资源生命周期使用 `state-lifecycle`。
- 多端或高风险评审使用 `dimina-review`；真实 UI 路径使用 `runtime-validation`；门禁判读使用 `dimina-gate`。
- 不为简单 UI、文案或已知位置的小修复自动启动多轮 Codex/Claude 对抗。是否委派和评审深度按共享 `review` skill 的风险判据决定。
- 用户明确批准修改 `dimina/` 时，在子 agent 任务书中写明该批准；agent 不得自行推定已获批准。
