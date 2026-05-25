# 鉴权设计

本项目没有用户名 / 密码，没有 JWT，没有 OAuth。**只用一枚 UUID**——既是登录凭证，又是外部 API 的 Bearer Token。下面解释这套设计的来由与边界。

## 三种身份信道

| 信道 | 用途 | 入口 |
| --- | --- | --- |
| Cookie session | 浏览器登录态 | `POST /api/auth/login` → 写 `cs_sid` cookie |
| Authorization Bearer | 外部脚本 / curl | `Authorization: Bearer <UUID>` |
| subToken | 公开订阅 URL | `/sub/<token>/...`，无需登录 |

核心实现在 [`src/lib/auth.js`](../../src/lib/auth.js) 的 `authenticate(request, env)`：

```
1. 先看 Authorization Bearer → 校验 UUID 格式 → getUser → 命中即返回
2. 再看 Cookie cs_sid     → getSession → getUser → 命中即返回
3. 都没命中: { user: null }
```

## 为什么 UUID 当登录凭证？

**优点**

- 零密码管理（不存哈希，不发邮件，不重置链接）。
- UUID v4 熵足够（122 bit 随机），暴破不现实。
- 用户与外部脚本可以共用同一份凭证，简化运维。

**缺点（务必让用户清楚）**

- UUID 泄露 = 失去账号。**没有第二因素，没有 IP 限制。**
- 用户不能"修改密码"。**只能让 admin 删旧 UUID + 发新 UUID。**

实践中这种模型适合：
- 个人 / 小团队 / 家庭共享。
- 信任彼此的合作者。

**不适合**：to-C 大规模平台、面向陌生人的公共服务。

## subToken 为什么单独存在

如果直接把 UUID 写进订阅 URL（例如 `/sub/<UUID>/clash`），任何拿到订阅链接的人——同事、客户端备份、截图——都能登录后台。subToken 与 UUID 隔离能解决这个问题：

| 维度 | UUID | subToken |
| --- | --- | --- |
| 用途 | 登录 / API | 仅订阅 |
| 暴露范围 | 用户本人 | 凡是用了这个客户端的人 |
| 长度 | 36 字符 | 16 字节 hex (32 字符) |
| 可重置 | ❌（要重建账号） | ✅（一键 rotate） |

实现：
- 首次"节点非空"时自动签发（[`crud.js:persistConfig`](../../src/handlers/crud.js)）。
- `POST /api/subscription/rotate` 删旧 + 发新。
- 用户改名 / 改节点都不会动 subToken。

## Admin Bootstrap

平台首次启动时，环境变量 `ADMIN_UUID` 会被自动注册成一个 `role: 'admin'` 用户：

```js
// src/lib/auth.js
let bootstrapped = false;
export async function ensureAdminBootstrap(env) {
    if (bootstrapped) return;
    const adminUuid = (env.ADMIN_UUID || '').trim();
    // ... 校验 + KV 写入 ...
    bootstrapped = true;
}
```

**几个关键点**：

1. **进程级幂等**：用模块级变量 `bootstrapped` 保证一个 Worker 实例只跑一次。但 Workers 是无状态的，每个冷启动都会重新跑——所以这个标记只是为了节省单次请求里的重复执行。
2. **每次 admin 命中**：`ensureAdminBootstrap` 也会被 `authenticate` 触发，意味着即使 KV 被人为清空，下次任意访问都会自愈出 admin 用户。
3. **角色修复**：如果 admin UUID 被普通操作覆盖成了 `role: 'user'`，bootstrap 会再升回 admin。**这是有意的兜底**，防止前端 bug 让自己锁后台。

## Session 实现细节

```js
// 32 字节 hex 拼接，避免 UUID 自带的横线
const sid = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
await setSession(env.CALPHER_KV, sid, uuid);
```

Cookie 设置：
```js
cs_sid=<sid>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure
```

- `HttpOnly` 防 XSS 拿 cookie。
- `SameSite=Lax` 允许跳转外链回来时带上，挡 CSRF 关键操作。
- `Secure` 仅在 maxAge>0 时加——这是为了兼容本地 `wrangler dev`（HTTP 无证书），登出时 maxAge=0 不带 Secure，浏览器才肯擦 cookie。

## 权限校验范围

所有需要登录的 handler 都接收 `authCtx`，内部用 `resolveTargetUuid(request, user)` 决定目标用户：

```js
// 默认目标 = 自己
// admin 可以传 ?uuid=other-user 越权操作
// 普通用户传别人的 uuid 会被 forbidden
```

具体实现见 [`src/handlers/config.js`](../../src/handlers/config.js) 顶部的 `resolveTargetUuid`。

## 不防的攻击

老实说一下这套模型不防什么：

- **UUID 暴力枚举**：理论上不可行（2^122 空间），但如果 admin UUID 用了顺序或可猜测值，就完蛋。**生成时用 `uuidgen` 或浏览器 `crypto.randomUUID()`**。
- **Worker 平台层 DDoS**：靠 CF 自己挡。
- **KV 命名空间穿越**：依赖 Cloudflare 平台隔离，我们不存任何加密敏感数据。
- **客户端订阅链接被多人共用**：业务上需要这种灵活性，平台不限。如有需要，可加 IP 白名单。
