# Cloudflare Workers 简介

> 本篇是给"第一次接触 Workers"的读者写的，已经熟的可以跳过去看 [项目初始化](02-project-setup.md)。

## 是什么

Cloudflare Workers 是一个**全球分布式 Serverless 平台**，运行在 Cloudflare 的边缘节点上（全球 300+ POP）。你写的 JavaScript / TypeScript / Rust（WASM）函数会就近响应用户请求，**冷启动 < 5ms**。

**与传统后端的差异**：

| 维度 | 传统 Node/Java 服务 | Cloudflare Worker |
| --- | --- | --- |
| 部署 | 单机/集群，需自己运维 | `wrangler deploy`，全球边缘自动复制 |
| 启动 | 进程常驻，启动慢 | 每次请求按需启动（V8 Isolate），冷启动 ~ms |
| 并发模型 | 多线程 / 进程池 | 单 Isolate 一次只处理一个请求，靠水平扩展 |
| 状态 | 进程内变量可用 | 进程内变量**不可靠**——多个 isolate / 跨区域 |
| 持久化 | 自己接 DB | 平台提供 KV / D1 / R2 / DO 等 |
| 文件系统 | 有 | 没有（只能从 bundle 读静态资源） |
| 计费 | 按机器/小时 | 按请求次数 + CPU 毫秒 |

## 限制（一定要知道）

| 限制 | 免费版 | 付费版 ($5/月) |
| --- | --- | --- |
| 请求数 | 100,000 / 天 | 1,000 万 / 月，超出 $0.30/百万 |
| CPU 时间 | 10ms / 请求 | 30 秒 / 请求 |
| 内存 | 128 MB | 128 MB |
| Worker 大小 | 1 MB (压缩后) | 10 MB (压缩后) |
| KV 读 | 100,000 / 天 | 1,000 万 / 月，超出 $0.50/百万 |
| KV 写 | 1,000 / 天 | 100 万 / 月，超出 $5/百万 |

本项目（calpher-sub）实际开销：
- 请求量：每个家庭/小团队几人，几百次/天，**永远在免费额度内**。
- KV 写：保存配置 + 节点 CRUD，每天个位数次，**永远在免费额度内**。
- KV 读：每次订阅刷新 3 次，每用户每天 < 100 次，**永远在免费额度内**。

> 部署本项目零成本，前提是你已经有 Cloudflare 账号。

## 工作模型

Worker 入口是一个 `fetch(request, env, ctx)` 函数：

```js
// src/index.js
export default {
    async fetch(request, env, ctx) {
        try {
            await ensureAdminBootstrap(env);
            return await route(request, env, ctx);
        } catch (e) {
            return json({ error: 'internal error: ' + (e && e.message) }, 500);
        }
    },
};
```

- `request`：标准 Fetch API 的 Request 对象。
- `env`：所有绑定（KV namespace、secrets、env vars）都挂在这里。
- `ctx`：执行上下文，提供 `ctx.waitUntil(promise)` 让你在响应后继续后台执行。

## 本项目用到的能力

| 能力 | 作用 | 在哪儿用 |
| --- | --- | --- |
| HTTP fetch 处理 | 入口路由 | `src/index.js` |
| KV 存储 | 用户/配置/session/subToken | `src/lib/kv.js` |
| Env Vars / Secrets | `ADMIN_UUID` | `src/lib/auth.js` |
| 静态资源打包 | 把 `index.html` 打进 bundle | `wrangler.toml` 的 rules + `import indexHtml from './static/index.html'` |
| Web Crypto API | 生成 session id、subToken | `crypto.randomUUID()`、`crypto.getRandomValues()` |

## 本项目没用到、但你可以了解的

- **Durable Objects**：强一致单实例对象，适合做计数器、锁、聊天室
- **D1**：SQLite 兼容的关系型数据库，适合需要 join / 事务的场景
- **R2**：S3 兼容对象存储，适合大文件 / 图片 / 备份
- **Queues**：消息队列，适合异步任务
- **Hyperdrive**：托管的外部 Postgres 连接池
- **Workers AI**：内置 LLM / 视觉模型
- **Cron Triggers**：定时任务

详见 [其他存储与服务](07-other-storage.md)。

## 官方学习入口

- 官方文档 https://developers.cloudflare.com/workers/
- 入门 tutorial https://developers.cloudflare.com/workers/get-started/guide/
- API 参考 https://developers.cloudflare.com/workers/runtime-apis/
- 示例库 https://workers.cloudflare.com/built-with
- 价格 https://developers.cloudflare.com/workers/platform/pricing/
