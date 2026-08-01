#!/usr/bin/env bash
#
# scripts/patrol.sh —— 只读巡检脚本
#
# 用途:用无头 `claude -p` 扫描仓库健康状况(main 分支 CI 最近 24h 状态 /
#      失败或 flaky 的 workflow / 过期(>14天未提交)远程分支 / 已通过 CI
#      但尚未合并的 open PR),把结果汇总成 markdown 摘要写入
#      patrol-reports/。全程只读,不做任何编辑、不 commit、不 push、
#      不合并/关闭 PR。
#
# 用法:
#   ./scripts/patrol.sh
#
# crontab 示例(每天 09:00 跑一次;下面这行不会被本脚本自动安装,
# 需要自行 `crontab -e` 手动添加):
#   0 9 * * * cd /Volumes/jdisk/code/dimina-kit && ./scripts/patrol.sh >>/tmp/dimina-kit-patrol-cron.log 2>&1
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REPORT_DIR="$REPO_ROOT/patrol-reports"
REPORT_FILE="$REPORT_DIR/patrol-$(date +%Y%m%d-%H%M).md"

# --- 前置检查:fail loud,不静默降级 ---

if ! command -v claude >/dev/null 2>&1; then
  echo "[patrol] 错误:未找到 claude CLI(无头巡检依赖 \`claude -p\`)。请先安装/配置 Claude Code CLI。" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[patrol] 错误:未找到 gh CLI。请先安装 GitHub CLI(https://cli.github.com)。" >&2
  exit 1
fi

# EchoTechFE 组织拒绝长寿命 PAT,gh 必须走 keyring OAuth(unset GITHUB_TOKEN)。
# 其它 remote 组织沿用当前环境变量,不额外处理。
GH_ENV_PREFIX=()
if git remote -v 2>/dev/null | grep -qi 'EchoTechFE'; then
  GH_ENV_PREFIX=(env -u GITHUB_TOKEN)
fi

if ! "${GH_ENV_PREFIX[@]}" gh auth status >/dev/null 2>&1; then
  echo "[patrol] 错误:gh 未认证或 token 已失效。请运行 \`${GH_ENV_PREFIX[*]:-} gh auth login\` 后重试。" >&2
  exit 1
fi

mkdir -p "$REPORT_DIR"

PROMPT=$(cat <<'EOF'
你是一个只读巡检助手,禁止做任何写操作:不改文件、不 commit、不 push、
不创建/合并/关闭 PR、不改 CI 配置、不触发任何 workflow。只允许读取信息。

请依次检查当前仓库并汇总成 markdown 报告:

1. main 分支最近 24 小时的 CI 状态:用 `gh run list --branch main --limit 30`
   (按需加 --json 字段筛选)查看,列出失败(failure)或不稳定(同一 workflow
   在窗口内失败/成功交替出现,即 flaky)的 workflow 名称及对应运行链接。
2. 过期远程分支:用 `git branch -r` 列出所有远程分支,结合每个分支最后一次
   提交的时间,筛出最后提交时间超过 14 天的分支,列出分支名与最后提交日期。
3. 已通过 CI(全部 check 为绿)但尚未合并的 open PR:用 `gh pr list --state open`
   拿到列表,再用 `gh pr checks <number>` 逐个确认 checks 是否全绿,列出
   PR 编号、标题、作者、最后更新时间。

只输出 markdown 格式的摘要报告本身(三级标题分节:CI 状态 / 过期分支 /
待合并的绿色 PR),不要输出解释性前后缀文字,不要执行任何修改类命令。
EOF
)

echo "[patrol] 开始巡检,输出到 $REPORT_FILE" >&2

"${GH_ENV_PREFIX[@]}" claude -p "$PROMPT" \
  --allowedTools "Read,Bash(gh:*),Bash(git:*),Grep,Glob" \
  > "$REPORT_FILE"

if [ ! -s "$REPORT_FILE" ]; then
  echo "[patrol] 错误:巡检输出为空,claude 调用可能失败,请检查上方日志。" >&2
  exit 1
fi

echo "[patrol] 巡检完成: $REPORT_FILE" >&2
