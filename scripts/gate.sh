#!/usr/bin/env bash
#
# scripts/gate.sh —— 一键顺序跑完仓库全部质量门禁
#
# 顺序固定为 lint → typecheck → test → pawl:check,不可打乱:pawl:check 依赖
# `pnpm test` 产出的工件(test-report*.json / coverage/coverage-summary.json),
# 必须排在 test 之后跑,否则会因工件缺失而以 exit 2(无法诚实测量)失败。
#
# 首个失败的步骤即终止脚本并以该步骤的退出码退出;全绿则打印一行紧凑汇总。
# 每步完整输出落盘到仓库外的临时目录,stdout 只保留每步状态行;失败时额外
# 打印失败步骤日志的最后 40 行,并提示完整日志路径。
#
# 用法:
#   ./scripts/gate.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dimina-kit-gate.XXXXXX")"
echo "[gate] 日志目录: ${LOG_DIR}"

SUMMARY=()
GATE_START=$(date +%s)

# 每步的名字与对应命令,顺序即执行顺序,故意用数组而非关联数组以锁定顺序。
STEP_NAMES=(lint typecheck test "pawl:check")
STEP_CMDS=(
  "pnpm run lint"
  "pnpm exec turbo run check-types --force"
  "pnpm run test"
  "pnpm run pawl:check"
)

print_summary() {
  local status_line="$1"
  echo ""
  echo "[gate] 汇总 (${status_line}):"
  for line in "${SUMMARY[@]}"; do
    echo "  ${line}"
  done
}

run_step() {
  local name="$1"
  local cmd="$2"
  local log_file="${LOG_DIR}/$(echo "${name}" | tr -c 'A-Za-z0-9_-' '_').log"

  echo "[gate] ▶ ${name} 开始…"
  local t0 t1 dur ec
  t0=$(date +%s)

  set +e
  bash -c "${cmd}" >"${log_file}" 2>&1
  ec=$?
  set -e

  t1=$(date +%s)
  dur=$((t1 - t0))

  if [ "${ec}" -ne 0 ]; then
    echo "[gate] ✗ ${name} 失败 (exit ${ec}, ${dur}s)"
    SUMMARY+=("✗ ${name} — FAIL (exit ${ec}, ${dur}s)")

    if [ "${name}" = "pawl:check" ] && [ "${ec}" -eq 2 ]; then
      echo "[gate] pawl exit 2 = 无法诚实测量(工件缺失 / adapter 崩溃或超时等工程故障),不是普通的门禁回归判定,请对照下方输出先排查测量链路本身。"
    fi

    echo "[gate] 完整日志: ${log_file}"
    echo "[gate] ---- ${name} 末 40 行输出 ----"
    tail -n 40 "${log_file}" || true
    echo "[gate] --------------------------------"

    print_summary "在 ${name} 处失败"
    exit "${ec}"
  fi

  echo "[gate] ✔ ${name} 完成 (${dur}s)"
  SUMMARY+=("✔ ${name} — OK (${dur}s)")
}

for i in "${!STEP_NAMES[@]}"; do
  run_step "${STEP_NAMES[$i]}" "${STEP_CMDS[$i]}"
done

GATE_END=$(date +%s)
print_summary "全绿, 总耗时 $((GATE_END - GATE_START))s"
