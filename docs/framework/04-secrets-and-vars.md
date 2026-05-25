# Secret 与环境变量

Worker 里访问 "配置值" 有三种渠道，**敏感度从低到高**：

| 渠道 | 文件/命令 | 是否进 bundle | 是否进 git |
| --- | --- | --- | --- |
| `[vars]` 明文 | `wrangler.toml` | ✅ 进 bundle，明文 | 通常 ✅ |
| `.dev.vars` | 项目根目录文件 | ❌ 仅本地开发 | ❌ (gitignore) |
| Secret | `wrangler secret put` | ❌ CF 后台加密存储 | ❌ |

无论用哪个，代码里都通过 `env.KEY_NAME` 访问。

## `[vars]` — 明文环境变量

```toml
# wrangler.toml
[vars]
LOG_LEVEL = "info"
PUBLIC_API_BASE = "https://api.example.com"
```

```js
console.log(env.LOG_LEVEL);  // "info"
```

**特点**：

- 部署时打进 Worker bundle，相当于代码常量。
- 任何人下载你的 Worker 源都能看到。
- **绝对不要放密钥、token、UUID 这类敏感值**。

适合：日志级别、第三方公开 URL、UI 文案开关。

## `.dev.vars` — 本地变量

```
# .dev.vars (gitignore)
ADMIN_UUID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
DEBUG=1
```

```js
// 本地 `npm run dev`:
env.ADMIN_UUID  // "aaaaaaaa-..."
```

**特点**：

- 仅 `wrangler dev` 读，**不会被部署**。
- 每个开发者维护自己的 `.dev.vars`，互不影响。
- 项目里放 `.dev.vars.example` 给同事参考。

`.gitignore` 里必加：
```
.dev.vars
```

本项目 `.dev.vars.example` 示例：

```
# 本地开发用的环境变量样例
# 复制为 .dev.vars 后填入真实值, 该文件已被 gitignore
ADMIN_UUID=00000000-0000-0000-0000-000000000000
```

## Secret — 生产敏感值

```bash
npx wrangler secret put ADMIN_UUID
# 提示输入, 粘贴一枚 UUID, 按回车
# Secret value uploaded.
```

```js
env.ADMIN_UUID  // 部署后的 worker 里能读到
```

**特点**：

- 通过 Cloudflare 后台加密存储。
- 一旦写入**无法再读出**（只能改/删）。
- 不会出现在 wrangler 文件里，不会进 git。

### 常用命令

```bash
# 写入 / 更新
npx wrangler secret put ADMIN_UUID

# 删除
npx wrangler secret delete ADMIN_UUID

# 列出当前 worker 的 secret 名 (不显示值)
npx wrangler secret list

# 批量写入 (从 JSON)
npx wrangler secret bulk secrets.json
```

### 适合放进 secret 的东西

- 第三方 API key、token（OpenAI、Stripe、Telegram bot...）
- 数据库连接串
- 加密用的对称密钥
- 初始管理员凭证（本项目的 `ADMIN_UUID` 就是这一类）

## 本项目使用

```js
// src/lib/auth.js
export async function ensureAdminBootstrap(env) {
    if (bootstrapped) return;
    const adminUuid = (env.ADMIN_UUID || '').trim();
    if (!adminUuid) {
        console.warn('[bootstrap] ADMIN_UUID env var not set');
        return;
    }
    // ...
}
```

部署流程：

```bash
# 1. 生产: 一次性写 secret
npx wrangler secret put ADMIN_UUID

# 2. 本地: 复制示例文件
cp .dev.vars.example .dev.vars
# 编辑里面的 ADMIN_UUID
```

两边可以用不同的 UUID——本地开发用测试 admin，生产用真实 admin。

## env 里还有什么

`env` 不止有 vars/secrets，还包含**所有绑定**：

```js
env.CALPHER_KV       // KV namespace
env.MY_DURABLE       // Durable Object (如果绑了)
env.MY_R2_BUCKET     // R2 bucket
env.MY_D1            // D1 数据库
env.ADMIN_UUID       // var/secret
```

**判断哪个是绑定哪个是 var/secret**：绑定通常是个有方法的对象（`.get()` / `.put()` / `.query()`）；var/secret 是字符串。

## 部署不同环境（dev/staging/prod）

CF Workers 支持多环境共一份代码：

```toml
# wrangler.toml
name = "calpher-sub"

[env.staging]
name = "calpher-sub-staging"
[[env.staging.kv_namespaces]]
binding = "CALPHER_KV"
id = "..."

[env.production]
name = "calpher-sub"
[[env.production.kv_namespaces]]
binding = "CALPHER_KV"
id = "..."
```

```bash
# 部署到 staging
npx wrangler deploy --env staging

# 每个环境单独维护 secret
npx wrangler secret put ADMIN_UUID --env staging
npx wrangler secret put ADMIN_UUID --env production
```

本项目目前**单环境**，需要时再拆。

## 官方文档

- Variables and secrets：https://developers.cloudflare.com/workers/configuration/secrets/
- Environment variables：https://developers.cloudflare.com/workers/configuration/environment-variables/
- Bindings 总览：https://developers.cloudflare.com/workers/runtime-apis/bindings/
