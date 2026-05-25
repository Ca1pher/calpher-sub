# 部署流程

本项目部署到 Cloudflare 全流程，从零账号到生产可用。

## 0. 前置准备

- 一个 Cloudflare 账号（免费版即可）：https://dash.cloudflare.com/sign-up
- Node.js 18+
- 本项目 clone 到本地

## 1. 安装依赖

```bash
cd calpher-sub
npm install
```

会装好 wrangler。

## 2. Cloudflare 登录

```bash
npx wrangler login
```

浏览器会弹出 OAuth 授权页，授权后回到终端就好。

授权 token 存在 `~/.config/.wrangler/config/default.toml`。

## 3. 复制 wrangler 配置模板

`wrangler.toml` 包含和 Cloudflare 账号绑定的 KV namespace id，不进 git。clone 后第一步:

```bash
cp wrangler.toml.example wrangler.toml
```

下一步创建 KV namespace 后，把真实 id 填进这个文件。

## 4. 创建 KV namespace

```bash
npx wrangler kv namespace create CALPHER_KV
```

输出：

```
🌀 Creating namespace with title "calpher-sub-CALPHER_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "CALPHER_KV"
id = "<your-namespace-id>"
```

再来一个预览版（本地 `--remote` 用）：

```bash
npx wrangler kv namespace create CALPHER_KV --preview
```

输出 `preview_id`，把两个 id 都填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CALPHER_KV"
id = "<your-namespace-id>"
preview_id = "<your-preview-id>"
```

## 5. 设置初始 admin UUID

```bash
# 生成一枚 UUID v4 (小写)
uuidgen | tr 'A-Z' 'a-z'
# 例: 12345678-1234-5678-1234-567812345678

# 写为 secret
npx wrangler secret put ADMIN_UUID
# 粘贴上面那个 UUID, 回车
```

**记牢这个 UUID**——它是你将来登录平台的唯一凭证。

## 6. 部署

```bash
npm run deploy
```

等价于 `npx wrangler deploy`。第一次部署会自动：

- 上传 Worker 代码到 CF
- 绑定 KV namespace
- 生成默认域名 `https://calpher-sub.<your-account>.workers.dev`

输出示例：

```
Total Upload: 65.32 KiB / gzip: 14.21 KiB
Uploaded calpher-sub (3.21 sec)
Deployed calpher-sub triggers (1.45 sec)
  https://calpher-sub.<your-account>.workers.dev
Current Version ID: 1a2b3c4d-...
```

## 7. 验证

打开输出里那个 `*.workers.dev` 链接：

- 应该看到登录页。
- 输入第 4 步的 admin UUID 登录。
- 进后台后能看到 admin 自己（"用户列表"）。

如果看到错误页：

```bash
npm run tail   # 看生产日志
```

## 常见问题

### Q1: 提示 `Authentication error`

```
✘ [ERROR] Authentication error [code: 10000]
```

→ 重新 `npx wrangler login`。

### Q2: 提示 `Could not route to /accounts/...`

→ 你账号没付费版但用了付费功能。本项目纯免费版能跑，确认 `wrangler.toml` 没误加 `compatibility_flags`。

### Q3: `EHOSTUNREACH 198.18.x.x` 或 `ConnectTimeoutError`

→ 你本机开了 Clash/Surge/v2rayN 的 TUN 或系统代理，`api.cloudflare.com` 被解析成 fake-IP。三种解法：

1. **临时关闭 Clash 系统代理 / TUN**，重新跑 deploy。
2. 在 Clash 规则里加 `DOMAIN-SUFFIX,api.cloudflare.com,DIRECT`，但生效要等订阅刷新。
3. 改本机 `/etc/hosts` 临时把 `api.cloudflare.com` 指到真实 IP（重启代理后失效）。

### Q4: 部署成功但访问页面 502

→ 检查 `npm run tail`，最常见原因：
- `ADMIN_UUID` 没设置 → 看到 `[bootstrap] ADMIN_UUID env var not set` 警告，平台仍能起，但没法登录。
- KV 绑定错误 → 看到 `env.CALPHER_KV is undefined`。

## 自定义域名（可选）

如果你有自己的域名（在 Cloudflare DNS 托管），可以让 worker 跑在 `sub.yourdomain.com` 而不是 `*.workers.dev`：

### 方式 1：Dashboard UI

1. 打开 https://dash.cloudflare.com → Workers & Pages → 选你的 worker
2. Settings → Triggers → Add Custom Domain
3. 输入 `sub.yourdomain.com`，CF 自动加 CNAME 和 SSL 证书

### 方式 2：`wrangler.toml`

```toml
[[routes]]
pattern = "sub.yourdomain.com/*"
custom_domain = true
```

```bash
npm run deploy
```

> 用 `*.workers.dev` 子域名在国内某些网络下访问慢，自定义域名 + 自家 DNS 托管会稳定一些。

## 部署历史与回滚

```bash
npx wrangler deployments list
```

输出每次部署的 ID + 时间。

```bash
npx wrangler rollback <deployment-id>
```

> 注意：回滚只回代码，KV 数据不会回滚。

## 灰度发布（付费版）

CF 支持基于百分比的灰度路由：

```bash
npx wrangler versions deploy --x-versions
# 部署成 "preview" 版本

npx wrangler versions secret put ADMIN_UUID --x-versions
# 给 preview 单独设 secret

# 把流量 10% 导到 preview
npx wrangler versions deploy --gradual 10
```

本项目用不上。

## 部署速度参考

- 第一次部署：~30s（含 KV 创建、secret 上传等）
- 日常 redeploy：3-5s（仅代码上传）
- 全球生效：~30s（边缘节点同步）

## 官方文档

- Deploy a Worker：https://developers.cloudflare.com/workers/get-started/guide/#5-deploy-your-project
- Custom Domains：https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Gradual Deployments：https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/
