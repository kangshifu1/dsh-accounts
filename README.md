# dsh-accounts

DSH 多租户账户与授权插件（PostgreSQL 后端，独立插件，不改 DSH 核心）。

## 能力
- 账户/角色/工作目录映射持久化到 PostgreSQL（schema 默认 `dsh`）
- 登录守卫（scrypt 密码 + HMAC-SHA256 会话 Cookie，复用 dsh-auth-plugin 设计）
- admin 管理 API（`/api/accounts`，需 admin 角色 + 会话 Cookie）
- 每账户独立工作目录（`<workspaceRoot>/<username>`，登录/建户时自动创建）

## admin API
- `GET /api/accounts/me` —— 当前登录用户信息 + 工作目录
- `GET /api/accounts` —— 列出全部账户（admin）
- `POST /api/accounts` —— 建户 {username, password, role?, workspace?}（admin）
- `PUT /api/accounts/:username` —— 改密/改角色/改目录（admin）
- `DELETE /api/accounts/:username` —— 删户（admin，不能删自己）

## 配置（profile cordis.patch.yml 内 id-targeted override）
```yaml
- id: dsh-accounts
  config:
    secret: "<会话签名密钥>"
    postgres:
      host: 127.0.0.1
      port: 5432
      database: postgres
      user: your_pg_user
      password: your_pg_password
      schema: dsh
    workspaceRoot: ~/.dsh/workspaces
    seedUsers:
      admin:
        password: "scrypt$..."
        role: admin
```

## 说明
- 首次启动（accounts 表为空）时写入 seedUsers；之后以数据库为准，重启不覆盖。
- DSH 会话 cwd 的「按用户强制」需要 client-connection 把 Cookie 身份透传到
  session.create RPC；当前 DSH 核心不提供该 seam（改动即破坏升级安全）。
  本插件提供 `/api/accounts/me` 作为用户工作目录的权威来源，供上层/客户端
  在创建会话时选择对应用户目录。
