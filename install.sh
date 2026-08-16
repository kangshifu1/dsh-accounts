#!/usr/bin/env bash
# dsh-accounts 一键安装脚本
# 在全新机器上完成：装依赖 → link 插件 → 写配置 → 启动。
# 用法：配置环境变量后直接运行（见下方“必填/可选”），或看 DEPLOYMENT.md §4。
set -euo pipefail

# ── 配置（环境变量覆盖；带 :? 的必填）────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$BASH_SOURCE")" && pwd)"
PLUGIN_DIR="${PLUGIN_DIR:-$SCRIPT_DIR}"                     # 默认：脚本所在目录即插件目录
DSH_CHECKOUT="${DSH_CHECKOUT:?请设置 DSH_CHECKOUT（deepseek-harness checkout 绝对路径）}"
DSH_PROFILE="${DSH_PROFILE:-web}"

PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_DATABASE="${PG_DATABASE:-postgres}"
PG_USER="${PG_USER:?请设置 PG_USER}"
PG_PASSWORD="${PG_PASSWORD:?请设置 PG_PASSWORD}"
PG_SCHEMA="${PG_SCHEMA:-dsh}"

WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/.dsh/workspaces}"   # 各用户目录根
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?请设置 ADMIN_PASSWORD（admin 初始密码）}"
INSTALL_PLUGIN_HUB="${INSTALL_PLUGIN_HUB:-1}"               # 1=顺带装插件商店；0=跳过

WEB_HOST="${WEB_HOST:-127.0.0.1}"                           # 远端部署设 0.0.0.0
WEB_PORT="${WEB_PORT:-3080}"
TRUSTED_HOSTS="${TRUSTED_HOSTS:-}"                          # 逗号分隔；远端部署必填
START="${START:-0}"                                         # 1=脚本内后台启动；0=只打印启动命令

NODE_BIN="${NODE_BIN:-}"                                    # 可选：node 所在 bin 目录（nvm 场景）
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

# ── 校验 ────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "错误：找不到 node（可用 NODE_BIN=... 指定）"; exit 1; }
command -v corepack >/dev/null 2>&1 || { echo "错误：找不到 corepack"; exit 1; }
[ -d "$DSH_CHECKOUT" ] || { echo "错误：DSH_CHECKOUT 不存在：$DSH_CHECKOUT"; exit 1; }
[ -f "$PLUGIN_DIR/package.json" ] || { echo "错误：插件目录不对（缺 package.json）：$PLUGIN_DIR"; exit 1; }

echo "==> checkout:   $DSH_CHECKOUT"
echo "==> 插件目录:   $PLUGIN_DIR"
echo "==> PostgreSQL: $PG_HOST:$PG_PORT/$PG_DATABASE (schema $PG_SCHEMA)"
echo "==> 工作区根:   $WORKSPACE_ROOT"

# ── 生成 secret 与 admin 密码哈希 ────────────────────────────────────────
if [ -z "${SECRET:-}" ]; then
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fi
ADMIN_HASH="$(node -e "const {scrypt,randomBytes}=require('crypto'); const s=randomBytes(16).toString('hex'); scrypt(process.argv[1], s, 32, (e,k)=>{if(e)throw e; console.log('scrypt$'+s+'$'+k.toString('hex'))})" "$ADMIN_PASSWORD")"
echo "==> 已生成 secret 与 admin 密码哈希"

# ── 1. 装依赖 ───────────────────────────────────────────────────────────
cd "$DSH_CHECKOUT"
echo "==> 安装 pg 驱动"
corepack pnpm dsh plugin --profile "$DSH_PROFILE" add pg
if [ "$INSTALL_PLUGIN_HUB" = "1" ]; then
  echo "==> 安装 dsh-plugin-hub（可选）"
  corepack pnpm dsh plugin --profile "$DSH_PROFILE" add dsh-plugin-hub || echo "（忽略）dsh-plugin-hub 安装失败，不影响多租户"
fi

# ── 2. 插件目录装 pg（link 后 import "pg" 才能解析）─────────────────────
cd "$PLUGIN_DIR"
corepack pnpm install

# ── 3. 链接插件 ──────────────────────────────────────────────────────────
cd "$DSH_CHECKOUT"
echo "==> 链接 dsh-accounts"
corepack pnpm dsh plugin --profile "$DSH_PROFILE" add "link:$PLUGIN_DIR"

# ── 4. 写配置 ────────────────────────────────────────────────────────────
PROFILE_DIR="$HOME/.dsh/profiles/$DSH_PROFILE"
mkdir -p "$PROFILE_DIR"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

if grep -q "id: dsh-accounts" "$PATCH_FILE" 2>/dev/null; then
  echo "==> 检测到已有 dsh-accounts 配置，跳过写入（如需更新请手动编辑 $PATCH_FILE）"
else
  cat >> "$PATCH_FILE" <<YAML

# ── dsh-accounts（由 install.sh 生成）──────────────────────────────────
- id: dsh-accounts
  config:
    enabled: true
    secret: "$SECRET"
    ttlHours: 24
    title: "DSH 登录"
    cookie: "dsh_session"
    postgres:
      host: $PG_HOST
      port: $PG_PORT
      database: $PG_DATABASE
      user: $PG_USER
      password: "$PG_PASSWORD"
      schema: $PG_SCHEMA
    workspaceRoot: "$WORKSPACE_ROOT"
    seedUsers:
      $ADMIN_USER:
        password: "$ADMIN_HASH"
        role: admin
YAML
  echo "==> 已写入配置 $PATCH_FILE"
fi

# ── 5. 启动 ──────────────────────────────────────────────────────────────
TRUSTED_ARGS=""
if [ -n "$TRUSTED_HOSTS" ]; then
  for h in $(echo "$TRUSTED_HOSTS" | tr ',' ' '); do TRUSTED_ARGS="$TRUSTED_ARGS --trusted-host $h"; done
fi

echo ""
echo "=========================================================="
echo "  安装完成。"
echo "=========================================================="
echo "  登录入口:   http://$WEB_HOST:$WEB_PORT/login"
echo "  admin 账号: $ADMIN_USER"
echo "  admin 管理: http://$WEB_HOST:$WEB_PORT/admin/users"
echo "  工作区根:   $WORKSPACE_ROOT"
echo ""
echo "  启动命令:"
echo "  cd $DSH_CHECKOUT"
echo "  corepack pnpm dsh web --host $WEB_HOST --port $WEB_PORT$TRUSTED_ARGS"
echo ""
echo "  提示："
echo "  - 首次启动会在 PG schema \"$PG_SCHEMA\" 建 accounts 表并 seed admin"
echo "  - 远端部署请设 WEB_HOST=0.0.0.0 且填 TRUSTED_HOSTS=域名"
echo "  - 请保存 secret 值（会话签名密钥）；重装时用 SECRET= 传入可保持会话不失效"
echo "=========================================================="

if [ "$START" = "1" ]; then
  echo "==> 后台启动中..."
  cd "$DSH_CHECKOUT"
  nohup corepack pnpm dsh web --host "$WEB_HOST" --port "$WEB_PORT" $TRUSTED_ARGS > /tmp/dsh-web.log 2>&1 &
  echo "==> 已后台启动，日志 /tmp/dsh-web.log，PID $!"
fi
