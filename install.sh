#!/usr/bin/env bash
# 一键安装 dsh-github-connect 插件（DeepSeek Harness, macOS / Linux）
#
# 懒人用法（一行）：
#   curl -fsSL https://raw.githubusercontent.com/meiao123/dsh-github-connect/master/install.sh | bash
#
# 高级用法：
#   bash install.sh [profile] [dir]     默认 profile=web, dir=$HOME/.dsh/plugins/dsh-github-connect
set -euo pipefail

NAME="dsh-github-connect"
REPO="https://github.com/meiao123/dsh-github-connect.git"
PROFILE="${1:-web}"
DIR="${2:-${HOME}/.dsh/plugins/dsh-github-connect}"

die() { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

echo "==> 安装 ${NAME} 插件 (profile: ${PROFILE})"

command -v dsh >/dev/null 2>&1 || die "未找到 dsh 命令。请先安装 DeepSeek Harness"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm。请先安装：npm i -g pnpm"
command -v git >/dev/null 2>&1 || die "未找到 git"

mkdir -p "$(dirname "$DIR")"
if [ -d "$DIR/.git" ]; then
  echo "==> 更新已有代码: $DIR"
  git -C "$DIR" pull --ff-only || echo "  (更新失败，继续使用现有代码)"
else
  echo "==> 克隆仓库到 $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

echo "==> 安装依赖 (pnpm install)"
(cd "$DIR" && pnpm install --no-frozen-lockfile)

echo "==> 注册进 profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "link:${DIR}"

echo ""
echo "  ✅ 安装完成！插件已加入 profile '$PROFILE' 的 bundles。"
echo "     最后一步：重启 DeepSeek Harness GUI ——"
echo "       1. 完全退出当前 dsh web；"
echo "       2. 重新运行: dsh web"
echo "       3. 刷新页面，对话框左下角出现 GitHub 按钮即成功。"
echo "     卸载：dsh plugin --profile $PROFILE remove $NAME"
