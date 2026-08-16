# DSH 多租户部署与重装说明

> 给 DeepSeek Harness（DSH）Web GUI 加**多租户登录 + PostgreSQL 账户存储 + 每账户独立工作目录 + 工作区/会话软隔离**。
> 全部在独立插件 `dsh-accounts` 内实现，**不改 DSH 核心源码**，DSH 升级不受影响。

---

## 1. 这套东西是什么 / 架构

| 组件 | 说明 |
|------|------|
| DSH 核心 | 原样，**未改任何源码**（升级安全的前提） |
| 插件 `dsh-accounts` | 本地独立插件目录，提供登录、账户、目录隔离、admin 管理页 |
| PostgreSQL | 唯一数据源：账户 / 角色 / 工作目录 / 禁用状态（schema `dsh`） |
| profile 配置 | `~/.dsh/profiles/web/cordis.patch.yml` + `package.json` |

实现的能力：

1. 登录门卫（scrypt 密码 + HMAC-SHA256 会话 Cookie），未登录跳 `/login`
2. 账户/角色/工作目录持久化到 PostgreSQL
3. admin 管理页 `/admin/users`：新增 / 编辑 / 禁用 / 重置密码 / 删除
4. 工作区隔离：`workspace.list` 按登录用户过滤（普通用户只看自己目录）
5. 会话隔离：`session.list` 按登录用户过滤（普通用户只看自己目录下的会话）
6. 会话目录强制：`session.create` 强制 cwd 落到各自目录（无法越界）

> 隔离性质：**软隔离**（界面层 + 会话创建层）。适合"信任的公司内部普通用户"——防止误看/乱串；不防"恶意用户直接调底层 API 硬越权"。硬隔离需改 DSH 核心（方案 B，已排除）。

---

## 2. 插件文件清单

插件位于（本机）：

~~~text
deepseekharnesslocal/dsh-accounts/
├── lib/
│   ├── index.js        # 宿主插件（登录守卫 + PG 账户 + admin API + 隔离拦截）
│   └── admin.html      # admin 用户管理页（每次请求实时读取，改 UI 刷新即可）
├── package.json        # name=dsh-accounts，依赖 pg，声明 dsh.bundle
├── cordis.patch.yml    # bundle 补丁（insert dsh-accounts 行）
├── install.sh          # 一键安装脚本（换机器直接跑）
├── DEPLOYMENT.md       # 本文档（随插件一起分发）
└── README.md
~~~

> 换机器时**整目录拷贝** `dsh-accounts/` 即可（含 `node_modules` 或重装 pg，见 §4）。

---

## 3. 前置条件

- Node.js ≥ 22（本机走 nvm：`/Users/kangxiaolin/.nvm/versions/node/v22.22.3`）
- pnpm（用 corepack 管理，版本 11.7.0）
- 一个可用的 PostgreSQL（任意实例：Docker / 云 / 自建均可）
- 一个已能启动 `dsh web` 的 DSH checkout

---

## 4. 全新机器安装步骤

> **一键脚本**：插件自带 `install.sh`，把下面四步封装好了。配置好环境变量直接跑：
> `DSH_CHECKOUT=... PG_USER=... PG_PASSWORD=... ADMIN_PASSWORD=... bash install.sh`
> （完整变量见脚本头注释；`START=1` 会顺带后台启动）。下面四步是手动等价流程。

### 4.1 装依赖插件（在 DSH checkout 目录执行）

~~~bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
cd /path/to/deepseek-harness

# 可选：图形化插件商店（不是多租户必需）
corepack pnpm dsh plugin --profile web add dsh-plugin-hub

# pg 驱动（dsh-accounts 依赖）
corepack pnpm dsh plugin --profile web add pg
~~~

### 4.2 链接本地插件 dsh-accounts

先把 `dsh-accounts/` 目录放到目标机器某处（记下绝对路径，下面用 `<PLUGIN_DIR>` 代替）：

~~~bash
# 先在本插件目录装好 pg（否则链接后 import "pg" 解析不到）
cd <PLUGIN_DIR>
corepack pnpm install

# 链接进 web profile
cd /path/to/deepseek-harness
corepack pnpm dsh plugin --profile web add link:<PLUGIN_DIR>
~~~

> `dsh plugin add` 是 pnpm 转发器：会把插件写进 `package.json` 依赖并加入
> `dsh.profile.bundles`；因为插件声明了 `dsh.bundle.patch`，其 `cordis.patch.yml`
> 也会自动成为配置层。

### 4.3 写 profile 配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加 dsh-accounts 的配置（完整示例见 §6）。
关键是把 `postgres` 和 `workspaceRoot`、`secret`、`seedUsers` 改成你的值。

### 4.4 启动 / 重启

~~~bash
cd /path/to/deepseek-harness
corepack pnpm dsh web
# 或后台： nohup corepack pnpm dsh web > /tmp/dsh-web.log 2>&1 &
~~~

重启后访问 `http://127.0.0.1:3080` 会跳登录页。

---

## 5. 账户与密码

| 账户 | 角色 | 密码（当前） | 工作目录 |
|------|------|--------------|----------|
| admin | admin | （生产环境自定） | `<workspaceRoot>/admin` |
| alice | user | （生产环境自定） | `<workspaceRoot>/alice` |

> 密码以 scrypt 哈希存 PG，明文只在首次 seed 出现。**上生产前务必改密码**（用 admin 登录后在
> `/admin/users` 里"重置密码"，或重新生成 seedUsers 哈希，见 §7）。

---

## 6. 配置参考（cordis.patch.yml 完整示例）

~~~yaml
- id: dsh-accounts
  config:
    enabled: true
    # 会话签名密钥：固定值保证重启后会话不失效。生产用强随机值，也可用 env 注入 DSH_AUTH_SECRET
    secret: "换成强随机 hex"
    ttlHours: 24
    title: "DSH 登录"
    cookie: "dsh_session"
    postgres:
      host: 127.0.0.1        # 远端部署改成 PG 地址
      port: 5432
      database: postgres
      user: your_pg_user
      password: your_pg_password
      schema: dsh            # 会在 PG 里自动建 schema + accounts 表
    workspaceRoot: "/path/to/dsh-workspaces"   # 各用户目录的根
    seedUsers:               # 仅 accounts 表为空时写入（首次启动）
      admin:
        password: "scrypt$..."
        role: admin
      alice:
        password: "scrypt$..."
        role: user
~~~

配置字段说明：

| 字段 | 默认 | 说明 |
|------|------|------|
| enabled | true | 总开关 |
| secret | 随机 | 会话签名密钥；留空每次重启随机（会话失效） |
| cookie | dsh_session | 会话 Cookie 名 |
| ttlHours | 24 | 会话有效期（小时） |
| postgres | 必填 | host/port/database/user/password/schema |
| workspaceRoot | ~/.dsh/workspaces | 各用户目录根，自动 `mkdir` |
| seedUsers | {} | 首次（空表）seed 的账户；之后以 PG 为准 |

---

## 7. 生成 scrypt 密码哈希

~~~bash
node --input-type=module -e "import {scrypt,randomBytes} from 'node:crypto'; const s=randomBytes(16).toString('hex'); scrypt('你的密码', s, 32, (e,k)=>{if(e)throw e; console.log('scrypt$'+s+'$'+k.toString('hex'))})"
~~~

把输出的 `scrypt$...` 填进 seedUsers 或 admin 页面"重置密码"即可。

---

## 8. admin 管理

- 入口：登录 admin 后访问 `http://<host>:<port>/admin/users`
- 非 admin 访问该页返回 403；未登录跳登录页
- REST API（需 admin 会话 Cookie）：

~~~text
GET    /api/accounts           # 列表 {me, accounts[]}
POST   /api/accounts           # 新增 {username,password,role?,workspace?}
PUT    /api/accounts/:u        # 编辑 {password?,role?,workspace?,disabled?}
DELETE /api/accounts/:u        # 删除
GET    /api/accounts/me        # 当前登录用户信息 + 工作目录
~~~

---

## 9. 验证清单（装完后跑一遍）

~~~bash
# 1) 登录（应返回 ok + Set-Cookie）
curl -i -X POST http://127.0.0.1:3080/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"..."}'

# 2) admin 看全部工作区
curl -b <cookie> -X POST http://127.0.0.1:3080/api/workspace/list -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"t","method":"workspace/list","payload":{"args":{}}}'

# 3) 普通用户看自己的（应只有自己目录）
# 4) session.list 普通用户应看不到别人的会话
# 5) session.create 指定别的 cwd 应被强制改回自己目录
~~~

---

## 10. 云端 / 公司部署（重点）

### 10.1 监听与可信主机

DSH 默认只监听 loopback，且 `/api` 有 trusted-host 篱笆。远程访问需要：

~~~bash
corepack pnpm dsh web --host 0.0.0.0 --port 3080 --trusted-host your.domain.com
~~~

- `--host 0.0.0.0`：对外监听
- `--trusted-host <域名或 ip:port>`：放行该来源的 /api 请求（可重复多个）

### 10.2 反向代理 + TLS（强烈建议）

用 nginx / caddy 前置，终止 TLS 并转发到 3080：

~~~text
公网 443 ──TLS──> nginx/caddy ──http──> 127.0.0.1:3080
~~~

- 只对外暴露 443（80 跳 443），3080 只对内
- 登录 Cookie 是 `HttpOnly + SameSite=Strict`，同域部署即可正常工作

### 10.3 PostgreSQL 用远端/托管实例

把 §6 里的 `postgres.host/port/database/user/password` 改成公司 PG 连接串即可。
建议：

- 单独建库 + 单独账号，最小权限（只给该 schema）
- 开启 SSL（插件支持 `postgres.ssl: true`）
- 定期 `pg_dump` 备份 `dsh.accounts`（这是账户数据，很重要）

### 10.4 安全清单（上生产前必做）

- [ ] 改掉 admin/alice 默认密码（scrypt 哈希）
- [ ] `secret` 换成强随机值并固定（或走 `DSH_AUTH_SECRET` 环境变量）
- [ ] 前端套 TLS + 反代，不裸暴露 3080
- [ ] PG 用强密码 + 最小权限 + SSL
- [ ] 磁盘配额 / 目录权限：workspaceRoot 下按用户隔离（本插件已按用户名分目录，建议再配系统级权限兜底）
- [ ] 明确"软隔离"边界：公司内普通用户可信任即可用；若需防恶意越权，需另行做方案 B（改核心）

---

## 11. DSH 升级注意

- 升级 DSH checkout（`git pull`）**不影响**本插件，因为：
  1. 插件在 profile 层（`~/.dsh/profiles/web`），不在 checkout 内
  2. 本地 `dsh-accounts` 目录用 `link:` 链接，checkout 升级不覆盖它
- 升级后若 `link:` 断链（罕见），重跑 §4.2 的 `dsh plugin add link:<PLUGIN_DIR>` 即可
- 插件拦截的是稳定 RPC 端点（`workspace.list` / `session.list` / `session.create`）
  与稳定服务（`ctx.apiProxy` / `ctx.workspaceRegistry`），若 DSH 大版本改这些内部接口，
  需同步更新插件（这是唯一可能的适配点）

---

## 12. 已知边界 / 注意事项

- `dsh-auth-plugin` 已装但**不在 bundles 中**（其用户表是静态配置，无法背靠 DB，被 `dsh-accounts` 取代）
- `dsh-plugin-hub` 自身的镜像/评分/审计仍用 SQLite（与账户数据无关）
- "所有配置都进 PG"做不到 100%：DSH 核心的会话/设置仍是 JSON/SQLite；本插件只把
  **账户/授权/目录映射**这类多租户数据放进 PG
- 软隔离不含文件系统 ACL：普通用户不会在界面看到彼此，但若有人直接调 API 仍可越权

---

## 13. 常用命令速查

~~~bash
# 安装/链接插件
corepack pnpm dsh plugin --profile web add <包名|link:<路径>>

# 查看组合后的配置树（验证插件是否加载、config 是否生效）
corepack pnpm dsh --profile web --dump-config | grep -A30 "id: dsh-accounts"

# 启动
corepack pnpm dsh web --host 0.0.0.0 --port 3080 --trusted-host your.domain.com
~~~

---

*本文档由当前已落地并验证通过的部署生成，改动配置后请同步更新此处。*
