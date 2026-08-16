/**
 * dsh-accounts — DSH 多租户账户与授权插件（PostgreSQL 后端，独立插件）
 *
 *  - 账户/角色/工作目录映射持久化到 PostgreSQL（不依赖 DSH 核心 JSON/SQLite 存储）
 *  - admin 管理账户：REST API + /admin/users 管理页（新增/编辑/禁用/重置密码/删除）
 *  - 每个账户独立工作目录（<workspaceRoot>/<username>）
 *  - 复用 dsh-auth-plugin 的 scrypt 密码 / HMAC-SHA256 会话令牌 / 门卫设计
 *  - 纯插件层实现，不修改 DSH 核心，升级安全
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import pg from "pg";

const { Pool } = pg;

const Config = z.object({
  enabled: z.boolean().default(true),
  secret: z.string().default(""),
  cookie: z.string().default("dsh_session"),
  ttlHours: z.number().default(24),
  title: z.string().default("DSH 登录"),
  publicPaths: z.array(String).default(["/login", "/api/auth/login", "/api/auth/logout", "/favicon.ico"]),
  adminPath: z.string().default("/admin/users"),
  postgres: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().default(5432),
    database: z.string().default("postgres"),
    user: z.string().required(),
    password: z.string().required(),
    schema: z.string().default("dsh"),
    ssl: z.union([z.boolean(), z.object({})]).default(false),
  }),
  workspaceRoot: z.string().default(""),
  seedUsers: z.dict(z.object({
    password: z.string().required(),
    role: z.string().default("user"),
    workspace: z.string().default(""),
  })).default({}),
});

const name = "dsh-accounts";
const inject = ["webServer"];

const LOGIN_PATH = "/login";
const API_LOGIN = "/api/auth/login";
const API_LOGOUT = "/api/auth/logout";
const ACCOUNTS_PREFIX = "/api/accounts";
const AUTH_HEADER = "authorization";

// ── 密码（scrypt） ──
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString("hex");
    scrypt(password, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve("scrypt$" + salt + "$" + key.toString("hex"));
    });
  });
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string" || typeof password !== "string") return false;
  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    const salt = parts[1];
    const hash = parts[2];
    if (!salt || !hash) return false;
    const derived = await new Promise((resolve, reject) => {
      scrypt(password, salt, 32, (error, key) => error ? reject(error) : resolve(key));
    });
    const expected = Buffer.from(hash, "hex");
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  }
  return stored === password;
}

// ── 会话令牌（HMAC-SHA256） ──
function makeToken(secret, username, role, ttlMs) {
  const body = Buffer.from(JSON.stringify({ u: username, r: role, exp: Date.now() + ttlMs })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}

function verifyToken(token, secret) {
  if (typeof token !== "string" || !secret) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── HTTP 小工具 ──
function pathOf(req) {
  return new URL(req.url ?? "/", "http://dsh.local").pathname;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function cookieHeader(name, value, ttlSeconds) {
  let out = name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Strict";
  if (ttlSeconds !== undefined) out += "; Max-Age=" + ttlSeconds;
  return out;
}

function clearCookieHeader(name) {
  return name + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function extractToken(req, cookieName) {
  const fromCookie = parseCookies(req.headers.cookie)[cookieName];
  if (fromCookie) return fromCookie;
  const auth = req.headers[AUTH_HEADER];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function readLoginBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (contentType.includes("application/x-www-form-urlencoded")) {
        resolve(Object.fromEntries(new URLSearchParams(data)));
        return;
      }
      try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

// ── 登录页 ──
function loginPage(title, error) {
  const err = error || "";
  const errDisplay = err ? "block" : "none";
  return [
    "<!DOCTYPE html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "<meta charset=\"UTF-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
    "<title>" + title + "</title>",
    "<style>",
    "*{margin:0;padding:0;box-sizing:border-box}",
    "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);min-height:100vh;display:flex;align-items:center;justify-content:center}",
    ".card{background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.35);padding:2.5rem;width:100%;max-width:380px;margin:1rem}",
    "h1{font-size:1.5rem;color:#1a1a2e;margin-bottom:.25rem;text-align:center}",
    ".sub{color:#888;font-size:.85rem;text-align:center;margin-bottom:1.75rem}",
    "label{display:block;font-size:.85rem;color:#555;margin-bottom:.4rem;font-weight:600}",
    "input{width:100%;padding:.7rem .9rem;border:2px solid #e5e7eb;border-radius:8px;font-size:1rem;margin-bottom:1.1rem}",
    "input:focus{outline:none;border-color:#0f3460}",
    "button{width:100%;padding:.8rem;background:#0f3460;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}",
    "button:hover{background:#16213e}",
    ".err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:.6rem .8rem;font-size:.85rem;margin-bottom:1rem;display:" + errDisplay + "}",
    ".foot{margin-top:1.5rem;text-align:center;color:#bbb;font-size:.75rem}",
    ".admin-link{margin-top:.6rem;text-align:center;font-size:.8rem}",
    ".admin-link a{color:#0f3460;text-decoration:none}",
    "</style>",
    "</head>",
    "<body>",
    "<div class=\"card\">",
    "<h1>🔐 " + title + "</h1>",
    "<p class=\"sub\">请输入凭据以继续</p>",
    "<div class=\"err\">" + err + "</div>",
    "<form method=\"POST\" action=\"" + API_LOGIN + "\">",
    "<label for=\"u\">用户名</label>",
    "<input id=\"u\" name=\"username\" required autofocus autocomplete=\"username\">",
    "<label for=\"p\">密码</label>",
    "<input id=\"p\" name=\"password\" type=\"password\" required autocomplete=\"current-password\">",
    "<button type=\"submit\">登 录</button>",
    "</form>",
    "<div class=\"foot\">DeepSeek Harness · dsh-accounts</div>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

// ── 插件入口 ──
async function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info("[dsh-accounts] disabled");
    return;
  }

  const secret = config.secret || process.env.DSH_AUTH_SECRET || randomBytes(32).toString("hex");
  const ttlMs = config.ttlHours * 3600 * 1000;
  const schema = config.postgres.schema;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("[dsh-accounts] invalid postgres.schema: " + schema);
  const workspaceRoot = config.workspaceRoot || join(homedir(), ".dsh", "workspaces");

  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    ssl: config.postgres.ssl === true ? { rejectUnauthorized: false } : (config.postgres.ssl || undefined),
    max: 5,
  });
  ctx.on("dispose", () => { void pool.end(); });

  await pool.query("CREATE SCHEMA IF NOT EXISTS " + schema);
  await pool.query("CREATE TABLE IF NOT EXISTS " + schema + ".accounts (username text PRIMARY KEY, password_hash text NOT NULL, role text NOT NULL DEFAULT 'user', workspace_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("ALTER TABLE " + schema + ".accounts ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false");

  const workspaceFor = (username) => join(workspaceRoot, username);
  async function ensureWorkspace(username) {
    const dir = workspaceFor(username);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // 首次启动（空表）时写入种子账户
  const counted = await pool.query("SELECT count(*)::int AS count FROM " + schema + ".accounts");
  if (counted.rows[0].count === 0) {
    for (const [username, spec] of Object.entries(config.seedUsers)) {
      const hash = spec.password.startsWith("scrypt$") ? spec.password : await hashPassword(spec.password);
      const dir = spec.workspace ? join(workspaceRoot, spec.workspace) : workspaceFor(username);
      await ensureWorkspace(username);
      await pool.query("INSERT INTO " + schema + ".accounts (username, password_hash, role, workspace_path) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING", [username, hash, spec.role, dir]);
    }
    ctx.logger.info("[dsh-accounts] seeded " + Object.keys(config.seedUsers).length + " account(s)");
  }

  async function loadUser(username) {
    const r = await pool.query("SELECT username, password_hash, role, workspace_path, disabled FROM " + schema + ".accounts WHERE username = $1", [username]);
    return r.rows[0] ?? null;
  }
  async function listUsers() {
    const r = await pool.query("SELECT username, role, workspace_path, disabled, created_at, updated_at FROM " + schema + ".accounts ORDER BY created_at");
    return r.rows.map((row) => ({ username: row.username, role: row.role, workspace: row.workspace_path, disabled: row.disabled, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  function authUser(req) {
    const token = extractToken(req, config.cookie);
    return token ? verifyToken(token, secret) : null;
  }

  const loginHandler = async (req, res) => {
    const path = pathOf(req);
    if (req.method === "GET" && path === LOGIN_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(loginPage(config.title));
      return;
    }
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    let body = {};
    try { body = await readLoginBody(req); } catch { return json(res, 400, { error: "invalid body" }); }
    const username = body.username;
    const password = body.password;
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return json(res, 400, { error: "username and password required" });
    }
    const user = await loadUser(username);
    const contentType = String(req.headers["content-type"] ?? "");
    if (!user || !await verifyPassword(password, user.password_hash)) {
      ctx.logger.warn("[dsh-accounts] login failed: password " + username + " (bad credentials)");
      if (contentType.includes("application/json")) return json(res, 401, { error: "invalid credentials" });
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      res.end(loginPage(config.title, "用户名或密码错误"));
      return;
    }
    if (user.disabled) {
      ctx.logger.warn("[dsh-accounts] login failed: password " + username + " (account disabled)");
      if (contentType.includes("application/json")) return json(res, 403, { error: "account disabled" });
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      res.end(loginPage(config.title, "该账户已被禁用"));
      return;
    }
    await ensureWorkspace(username);
    // 软隔离：把用户目录注册为 DSH 工作区（workspace.list 会按用户过滤）
    try {
      const reg = ctx.get("workspaceRegistry");
      if (reg !== undefined) { await reg.create(workspaceFor(username), username); }
    } catch { /* 注册失败不阻断登录 */ }
    const token = makeToken(secret, user.username, user.role, ttlMs);
    res.setHeader("set-cookie", cookieHeader(config.cookie, token, Math.floor(ttlMs / 1000)));
    ctx.logger.info("[dsh-accounts] login ok: password " + username);
    if (contentType.includes("application/json")) return json(res, 200, { ok: true, username: user.username, role: user.role });
    res.writeHead(302, { location: "/" });
    res.end();
  };

  const logoutHandler = (req, res) => {
    res.setHeader("set-cookie", clearCookieHeader(config.cookie));
    if (String(req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(302, { location: LOGIN_PATH });
      res.end();
    } else {
      json(res, 200, { ok: true });
    }
  };

  const accountsHandler = async (req, res) => {
    const sub = pathOf(req).slice(ACCOUNTS_PREFIX.length) || "/";
    const method = req.method ?? "GET";

    if (sub === "/me") {
      const auth = authUser(req);
      if (!auth) return json(res, 401, { error: "unauthorized" });
      const user = await loadUser(auth.u);
      if (!user) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { username: user.username, role: user.role, workspace: user.workspace_path, disabled: user.disabled });
    }

    const auth = authUser(req);
    if (!auth) return json(res, 401, { error: "unauthorized" });
    if (auth.r !== "admin") return json(res, 403, { error: "forbidden", message: "admin role required" });

    if (sub === "/" || sub === "") {
      if (method === "GET") return json(res, 200, { me: auth.u, accounts: await listUsers() });
      if (method === "POST") {
        let body = {};
        try { body = await readJsonBody(req); } catch { return json(res, 400, { error: "invalid body" }); }
        const username = body.username;
        const password = body.password;
        if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) return json(res, 400, { error: "invalid username" });
        if (typeof password !== "string" || password.length < 6) return json(res, 400, { error: "password must be at least 6 characters" });
        if (await loadUser(username)) return json(res, 409, { error: "username already exists" });
        const hash = await hashPassword(password);
        const role = typeof body.role === "string" ? body.role : "user";
        const dir = typeof body.workspace === "string" && body.workspace ? join(workspaceRoot, body.workspace) : workspaceFor(username);
        await ensureWorkspace(username);
        await pool.query("INSERT INTO " + schema + ".accounts (username, password_hash, role, workspace_path, disabled) VALUES ($1,$2,$3,$4,$5)", [username, hash, role, dir, false]);
        ctx.logger.info("[dsh-accounts] admin created account " + username);
        return json(res, 201, { username, role, workspace: dir, disabled: false });
      }
    }

    const m = /^\/([^/]+)\/?$/.exec(sub);
    if (m) {
      const username = decodeURIComponent(m[1]);
      if (method === "DELETE") {
        if (username === auth.u) return json(res, 400, { error: "cannot delete yourself" });
        const r = await pool.query("DELETE FROM " + schema + ".accounts WHERE username = $1", [username]);
        if (r.rowCount === 0) return json(res, 404, { error: "account not found" });
        ctx.logger.info("[dsh-accounts] admin deleted account " + username);
        return json(res, 200, { ok: true });
      }
      if (method === "PUT") {
        let body = {};
        try { body = await readJsonBody(req); } catch { return json(res, 400, { error: "invalid body" }); }
        const existing = await loadUser(username);
        if (!existing) return json(res, 404, { error: "account not found" });
        const password = typeof body.password === "string" && body.password ? await hashPassword(body.password) : existing.password_hash;
        const role = typeof body.role === "string" ? body.role : existing.role;
        const disabled = typeof body.disabled === "boolean" ? body.disabled : existing.disabled;
        let dir = existing.workspace_path;
        if (typeof body.workspace === "string" && body.workspace) {
          dir = join(workspaceRoot, body.workspace);
          await mkdir(dir, { recursive: true });
        }
        await pool.query("UPDATE " + schema + ".accounts SET password_hash = $2, role = $3, workspace_path = $4, disabled = $5, updated_at = now() WHERE username = $1", [username, password, role, dir, disabled]);
        ctx.logger.info("[dsh-accounts] admin updated account " + username);
        return json(res, 200, { username, role, workspace: dir, disabled });
      }
    }

    return json(res, 404, { error: "not found" });
  };

  // 管理页：admin 角色可见（每次请求读取，改 UI 无需重启）
  const adminPageHandler = (req, res) => {
    const auth = authUser(req);
    if (!auth) { res.writeHead(302, { location: LOGIN_PATH }); res.end(); return; }
    if (auth.r !== "admin") {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("admin role required");
      return;
    }
    let html = "";
    try { html = readFileSync(new URL("./admin.html", import.meta.url), "utf8"); }
    catch { ctx.logger.warn("[dsh-accounts] admin.html read failed"); html = "<h1>admin page unavailable</h1>"; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };

  // ── 软隔离：workspace.list 按登录用户过滤 ──
  const workspaceViewOf = (w) => ({
    workspaceId: w.id,
    path: w.path,
    title: w.title,
    sessionIds: Array.from(w.sessionIds ?? []),
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });

  const workspaceListHandler = async (req, res) => {
    const token = extractToken(req, config.cookie);
    const user = token ? verifyToken(token, secret) : null;
    let body = {};
    try { body = await readJsonBody(req); } catch { /* keep {} */ }
    const rpcId = typeof body.rpcId === "string" ? body.rpcId : "";
    const reply = (value) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } }));
    };
    if (!user) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: false, error: { code: "internal", message: "unauthorized", details: {} } } }));
      return;
    }
    const reg = ctx.get("workspaceRegistry");
    if (reg === undefined) return reply({ items: [], archivedSessionIds: [] });
    if (user.r === "admin") {
      return reply({ items: reg.list().map(workspaceViewOf), archivedSessionIds: Array.from(reg.archivedSessionIds ?? []) });
    }
    const dir = workspaceFor(user.u);
    const items = reg.list().filter((w) => w.path === dir || String(w.path).startsWith(dir + "/")).map(workspaceViewOf);
    return reply({ items, archivedSessionIds: [] });
  };

  // ── 软隔离：目录浏览 / 建目录 / 建工作区 限制在用户目录内 ──
  const dirFail = (res, rpcId, code, message) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: false, error: { code, message, details: {} } } }));
  };

  const hostListDirectoryHandler = async (req, res) => {
    const token = extractToken(req, config.cookie);
    const user = token ? verifyToken(token, secret) : null;
    let body = {};
    try { body = await readJsonBody(req); } catch { /* keep {} */ }
    const rpcId = typeof body.rpcId === "string" ? body.rpcId : "";
    const reply = (value) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } }));
    };
    if (!user) return dirFail(res, rpcId, "internal", "unauthorized");
    const args = (body.payload && body.payload.args) ? body.payload.args : {};
    const root = workspaceFor(user.u);
    const boundary = user.r === "admin" ? "/" : root;
    let path = typeof args.path === "string" && args.path ? args.path : (user.r === "admin" ? homedir() : root);
    if (user.r !== "admin" && path !== root && !path.startsWith(root + "/")) path = root;
    try {
      const dirents = await readdir(path, { withFileTypes: true });
      const entries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, path: join(path, d.name), hidden: d.name.startsWith(".") }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const crumbs = [];
      let cur = path;
      while (true) {
        crumbs.unshift({ name: basename(cur) || cur, path: cur, hidden: false });
        if (cur === boundary) break;
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      reply({ path, home: user.r === "admin" ? homedir() : root, crumbs, entries, truncated: false });
    } catch (e) {
      dirFail(res, rpcId, "directory-unreadable", String(e && e.message ? e.message : e));
    }
  };

  const hostPickDirectoryHandler = async (req, res) => {
    const token = extractToken(req, config.cookie);
    const user = token ? verifyToken(token, secret) : null;
    let body = {};
    try { body = await readJsonBody(req); } catch { /* keep {} */ }
    const rpcId = typeof body.rpcId === "string" ? body.rpcId : "";
    if (!user) return dirFail(res, rpcId, "internal", "unauthorized");
    if (user.r !== "admin") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value: { path: null } } }));
      return;
    }
    const apiProxy = ctx.get("apiProxy");
    if (apiProxy === undefined) return dirFail(res, rpcId, "internal", "api proxy unavailable");
    const full = await apiProxy.host.pickDirectory({ rpcId, payload: {} }, undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId, result: full.result }));
  };

  const hostCreateDirectoryHandler = async (req, res) => {
    const token = extractToken(req, config.cookie);
    const user = token ? verifyToken(token, secret) : null;
    let body = {};
    try { body = await readJsonBody(req); } catch { /* keep {} */ }
    const rpcId = typeof body.rpcId === "string" ? body.rpcId : "";
    if (!user) return dirFail(res, rpcId, "internal", "unauthorized");
    const args = (body.payload && body.payload.args) ? body.payload.args : {};
    const root = workspaceFor(user.u);
    if (user.r !== "admin") {
      const parent = typeof args.path === "string" ? args.path : root;
      if (parent !== root && !parent.startsWith(root + "/")) return dirFail(res, rpcId, "directory-create-failed", "只能在你的工作目录下创建");
    }
    const apiProxy = ctx.get("apiProxy");
    if (apiProxy === undefined) return dirFail(res, rpcId, "internal", "api proxy unavailable");
    const full = await apiProxy.host.createDirectory({ rpcId, payload: args });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId, result: full.result }));
  };

  const workspaceCreateHandler = async (req, res) => {
    const token = extractToken(req, config.cookie);
    const user = token ? verifyToken(token, secret) : null;
    let body = {};
    try { body = await readJsonBody(req); } catch { /* keep {} */ }
    const rpcId = typeof body.rpcId === "string" ? body.rpcId : "";
    if (!user) return dirFail(res, rpcId, "internal", "unauthorized");
    const args = (body.payload && body.payload.args) ? body.payload.args : {};
    const root = workspaceFor(user.u);
    if (user.r !== "admin") {
      const path = typeof args.path === "string" ? args.path : "";
      if (path !== root && !path.startsWith(root + "/")) {
        return dirFail(res, rpcId, "workspace-invalid-path", "只能在你的工作目录下创建工作区");
      }
    }
    const apiProxy = ctx.get("apiProxy");
    if (apiProxy === undefined) return dirFail(res, rpcId, "internal", "api proxy unavailable");
    const full = await apiProxy.workspace.create({ rpcId, payload: args });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId, result: full.result }));
  };

  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: LOGIN_PATH, handler: loginHandler }), "dsh-accounts: login page");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: API_LOGIN, handler: loginHandler }), "dsh-accounts: login api");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: API_LOGOUT, handler: logoutHandler }), "dsh-accounts: logout api");
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: ACCOUNTS_PREFIX, handler: accountsHandler }), "dsh-accounts: accounts api");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/workspace/list", handler: workspaceListHandler }), "dsh-accounts: workspace.list filter");
  // ── 软隔离：session.list 过滤 + session.create 强制 cwd ──
  const sessionListHandler = async (req, res) => {
    const token = extractToken(req, config.cookie);
    const user = token ? verifyToken(token, secret) : null;
    let body = {};
    try { body = await readJsonBody(req); } catch { /* keep {} */ }
    const rpcId = typeof body.rpcId === "string" ? body.rpcId : "";
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId, result }));
    };
    if (!user) return reply({ ok: false, error: { code: "internal", message: "unauthorized", details: {} } });
    const apiProxy = ctx.get("apiProxy");
    if (apiProxy === undefined) return reply({ ok: true, value: { items: [] } });
    const args = (body.payload && body.payload.args) ? body.payload.args : {};
    const full = await apiProxy.sessions.list({ rpcId, payload: args });
    if (!full.result.ok) return reply(full.result);
    if (user.r === "admin") return reply(full.result);
    const dir = workspaceFor(user.u);
    const items = full.result.value.items.filter((s) => s.cwd === dir || (typeof s.cwd === "string" && s.cwd.startsWith(dir + "/")));
    return reply({ ok: true, value: { items } });
  };

  const sessionCreateHandler = async (req, res) => {
    const token = extractToken(req, config.cookie);
    const user = token ? verifyToken(token, secret) : null;
    let body = {};
    try { body = await readJsonBody(req); } catch { /* keep {} */ }
    const rpcId = typeof body.rpcId === "string" ? body.rpcId : "";
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId, result }));
    };
    if (!user) return reply({ ok: false, error: { code: "internal", message: "unauthorized", details: {} } });
    const apiProxy = ctx.get("apiProxy");
    if (apiProxy === undefined) return reply({ ok: false, error: { code: "internal", message: "api proxy unavailable", details: {} } });
    const args = (body.payload && body.payload.args) ? body.payload.args : {};
    const forcedArgs = Object.assign({}, args);
    if (user.r !== "admin") {
      delete forcedArgs.workspaceId;
      forcedArgs.cwd = workspaceFor(user.u);
    }
    const full = await apiProxy.sessions.create({ rpcId, payload: forcedArgs });
    return reply(full.result);
  };

  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/session/list", handler: sessionListHandler }), "dsh-accounts: session.list filter");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/session/create", handler: sessionCreateHandler }), "dsh-accounts: session.create cwd");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/host/listDirectory", handler: hostListDirectoryHandler }), "dsh-accounts: host.listDirectory filter");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/host/pickDirectory", handler: hostPickDirectoryHandler }), "dsh-accounts: host.pickDirectory filter");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/host/createDirectory", handler: hostCreateDirectoryHandler }), "dsh-accounts: host.createDirectory filter");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/workspace/create", handler: workspaceCreateHandler }), "dsh-accounts: workspace.create filter");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: config.adminPath, handler: adminPageHandler }), "dsh-accounts: admin page");

  const mountGate = () => {
    const original = ctx.webServer.fallback;
    const notFound = (req, res) => { res.writeHead(404); res.end(); };
    const gate = async (req, res) => {
      const path = pathOf(req);
      if (config.publicPaths.some((p) => path === p || path.startsWith(p))) return (original ?? notFound)(req, res);
      const token = extractToken(req, config.cookie);
      const user = token ? verifyToken(token, secret) : null;
      if (!user) {
        if (String(req.headers.accept ?? "").includes("text/html")) {
          res.writeHead(302, { location: LOGIN_PATH });
          res.end();
        } else {
          return json(res, 401, { error: "unauthorized", code: "auth_required" });
        }
        return;
      }
      req.authUser = user;
      return (original ?? notFound)(req, res);
    };
    ctx.webServer.fallback = gate;
    ctx.effect(() => () => { ctx.webServer.fallback = original; }, "dsh-accounts: restore fallback");
  };

  const settled = ctx.get("loader")?.await();
  if (settled === undefined) mountGate();
  else settled.then(mountGate, () => mountGate());

  ctx.logger.info("[dsh-accounts] enabled (pg=" + config.postgres.host + ":" + config.postgres.port + "/" + config.postgres.database + ", schema=" + schema + ", workspaceRoot=" + workspaceRoot + ", adminPath=" + config.adminPath + ")");
}

export { name, inject, Config, apply, hashPassword, verifyPassword, verifyToken };
export default { name, inject, Config, apply };
