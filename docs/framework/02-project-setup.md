# 项目初始化与 wrangler

`wrangler` 是 Cloudflare Workers 的官方 CLI——所有"开发、调试、部署、KV 管理、secret 管理"都通过它完成。

## 从零起一个 Worker 项目（参考）

如果你想自己开新项目，官方推荐：

```bash
npm create cloudflare@latest -- my-worker
```

它会问你模板（"Hello World" / "Static site" / "Scheduled worker"...），然后生成完整骨架。

本项目 (`calpher-sub`) 不是用这个模板起的，是手写 `package.json` + `wrangler.toml` 拼出来的，更轻量。结构如下：

```
calpher-sub/
├── package.json              # 仅声明 wrangler 作为 devDep
├── wrangler.toml             # Worker 配置 (KV/Rules/Vars)
├── .dev.vars.example         # 本地变量示例 (复制为 .dev.vars)
├── .gitignore                # 忽略 node_modules / .wrangler / .dev.vars
└── src/
    ├── index.js              # 入口
    ├── handlers/
    ├── lib/
    └── static/
        └── index.html
```

## `package.json` 最小化

```json
{
  "name": "calpher-sub",
  "version": "1.0.1",
  "private": true,
  "main": "src/index.js",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail"
  },
  "devDependencies": {
    "wrangler": "^3.90.0"
  }
}
```

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 本地起 worker，热重载 |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run tail` | 实时拉生产 worker 的 `console.log` |

没有 build 步骤——wrangler 内置 esbuild。

## `wrangler.toml` 配置

```toml
name = "calpher-sub"                        # Worker 名 (子域名)
main = "src/index.js"                       # 入口
compatibility_date = "2025-01-15"           # 平台 API 版本快照

# 把 .html 文件作为字符串打进 bundle (供 import)
rules = [
  { type = "Text", globs = ["**/*.html"], fallthrough = true }
]

# KV 绑定
[[kv_namespaces]]
binding = "CALPHER_KV"
id = "<your-namespace-id>"
preview_id = "<your-preview-id>"

# 环境变量 (非敏感)
[vars]
# ADMIN_UUID = "..."  # 推荐用 secret 代替
```

### 重要字段说明

- **`name`**：决定默认部署域名 `https://<name>.<your-account>.workers.dev`。
- **`compatibility_date`**：锁定 Workers 运行时 API 版本，避免平台升级破坏你的代码。改这个 date 前先看 https://developers.cloudflare.com/workers/configuration/compatibility-flags/。
- **`rules`**：构建时如何处理非 JS 文件。`type: "Text"` 让 `.html` 被当字符串 import；其他常用值：`"Data"`（二进制 ArrayBuffer）、`"CompiledWasm"`（WASM 模块）。详见 [静态资源打包](06-static-bundling.md)。
- **`[[kv_namespaces]]`**：KV 绑定，详见 [KV 存储](03-kv-storage.md)。
- **`[vars]`**：明文环境变量，会被打进 bundle，不要放敏感数据。

## 全局安装 vs npx

我们没有全局装 wrangler，直接用 `npx wrangler` 跑当前项目的本地版本：

```bash
npx wrangler --version       # 跑 devDep 里那个版本
npx wrangler kv namespace create CALPHER_KV
npx wrangler secret put ADMIN_UUID
npx wrangler deploy
```

好处：每个项目锁定自己的 wrangler 版本，不冲突。

## 首次登录 Cloudflare

```bash
npx wrangler login           # 弹浏览器, OAuth 授权
```

登录后会在 `~/.config/.wrangler/config/default.toml` 写一个 token。

如果你在没有浏览器的服务器上：

```bash
# 在 dashboard 手动生成 API Token
# 然后:
export CLOUDFLARE_API_TOKEN=xxx
npx wrangler deploy
```

## 本地开发模式

```bash
npm run dev
```

默认起在 http://127.0.0.1:8787。

**关键开关**：

| 参数 | 作用 |
| --- | --- |
| `--local`（默认）| 用 miniflare 在本地模拟 KV/DO/R2 |
| `--remote` | 直接连上你账号的真实 KV（用于调试生产数据） |
| `--port 1234` | 自定义端口 |
| `--ip 0.0.0.0` | 监听所有网卡（局域网手机能访问） |

### `.dev.vars`

本地开发时的 secret/var 写在 `.dev.vars`（gitignore）：

```
ADMIN_UUID=00000000-0000-0000-0000-000000000000
```

部署时不会上传，生产用 `wrangler secret put`。详见 [Secret 与环境变量](04-secrets-and-vars.md)。

## 部署相关命令

```bash
npx wrangler deploy                # 部署当前代码
npx wrangler deployments list      # 看部署历史
npx wrangler rollback              # 回滚到上一个版本
npx wrangler tail                  # 实时看日志
npx wrangler tail --format pretty  # 美化 JSON 日志
npx wrangler dev --remote          # 用生产 KV 跑本地代码 (调试用)
```

## 官方文档

- wrangler 命令参考：https://developers.cloudflare.com/workers/wrangler/commands/
- 配置文件参考：https://developers.cloudflare.com/workers/wrangler/configuration/
- API tokens：https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
