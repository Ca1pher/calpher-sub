# 其他存储与服务

本项目目前只用了 **KV**。这一篇是给"将来想扩展功能"做的速览——每种服务一段简介、典型用法、官方链接。**还没用到的部分以引导为主**，等用上了再回来补详细笔记。

---

## D1（关系型数据库）

> **未在本项目使用**

CF 的 SQLite 兼容关系型数据库，免费版每天 5 百万行读 + 10 万行写，**支持事务与 join**。

**适合**：用户量起来后需要复杂查询、需要事务保证的场景。

**示例**：

```toml
# wrangler.toml
[[d1_databases]]
binding = "MY_DB"
database_name = "calpher-prod"
database_id = "xxxx-xxxx-xxxx"
```

```js
const { results } = await env.MY_DB.prepare(
    "SELECT * FROM users WHERE role = ?"
).bind("admin").all();
```

**何时换上**：本项目的 `kv.list` + 逐 `get` 模式在用户数百时还行，**到几千就该考虑挪到 D1**（一个 SELECT 比 N+1 次 KV 读快得多）。

- 文档：https://developers.cloudflare.com/d1/
- 创建：`npx wrangler d1 create <name>`
- 迁移：`npx wrangler d1 migrations create / apply`

---

## R2（对象存储，S3 兼容）

> **未在本项目使用**

S3 兼容、**零出站流量费**，每月 10 GB 免费存储。

**适合**：用户上传文件、备份、图片、视频、日志归档。

```toml
[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "calpher-backups"
```

```js
await env.MY_BUCKET.put('configs/' + uuid + '.yaml', yamlString);
const obj = await env.MY_BUCKET.get('configs/' + uuid + '.yaml');
const text = await obj.text();
```

**潜在用法（本项目）**：定期把每个用户的 config 备份到 R2，作为 KV 灾备。

- 文档：https://developers.cloudflare.com/r2/
- 创建：`npx wrangler r2 bucket create <name>`

---

## Durable Objects（强一致状态）

> **未在本项目使用**

**Workers 平台唯一提供强一致 + 单实例语义的能力**。每个 DO 实例是一个有状态的"虚拟对象"，全球唯一，有自己的 SQLite 存储。

**适合**：
- 计数器、限流器（KV 不能原子加）
- 实时聊天室、协作文档（WebSocket + 共享状态）
- 锁 / 队列协调

**简单示例**：

```js
export class Counter {
    constructor(state, env) { this.state = state; }
    async fetch(req) {
        let n = (await this.state.storage.get("n")) || 0;
        n++;
        await this.state.storage.put("n", n);
        return new Response(String(n));
    }
}
```

```toml
[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Counter"]
```

**潜在用法（本项目）**：如果未来要做"多 admin 同时编辑同一用户 config 防冲突"，DO 是最佳选择。

- 文档：https://developers.cloudflare.com/durable-objects/
- 价格：付费版才能用（$5/月起）

---

## Queues（消息队列）

> **未在本项目使用**

**Workers 原生消息队列**，支持批处理、重试、死信队列。

**适合**：
- 异步任务（订阅生成、邮件发送）
- 流量削峰
- Worker A 触发，Worker B 消费

```toml
[[queues.producers]]
binding = "MY_QUEUE"
queue = "calpher-jobs"

[[queues.consumers]]
queue = "calpher-jobs"
max_batch_size = 10
```

```js
// 生产
await env.MY_QUEUE.send({ type: 'rebuild', uuid: '...' });

// 消费 (在另一个 worker)
export default {
    async queue(batch, env) {
        for (const msg of batch.messages) {
            await processJob(msg.body);
            msg.ack();
        }
    }
};
```

- 文档：https://developers.cloudflare.com/queues/

---

## Hyperdrive（外部 Postgres / MySQL 加速）

> **未在本项目使用**

如果你已经有外部 PostgreSQL / MySQL，Hyperdrive 提供连接池 + 全球缓存，让 Worker 用得像本地 DB 一样快。

```js
import postgres from 'postgres';
const sql = postgres(env.HYPERDRIVE.connectionString);
const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
```

**适合**：已有 Postgres/MySQL 应用，要迁移到 Worker 但不想换 DB。

- 文档：https://developers.cloudflare.com/hyperdrive/

---

## Cron Triggers（定时任务）

> **未在本项目使用**

让 Worker 按 cron 表达式定时执行（不依赖外部触发）。

```toml
[triggers]
crons = ["0 */6 * * *"]    # 每 6 小时
```

```js
export default {
    async scheduled(event, env, ctx) {
        // 定时任务逻辑
        await rebuildAllSubscriptions(env);
    },
    async fetch(req, env, ctx) { /* 普通 HTTP 入口 */ },
};
```

**潜在用法（本项目）**：每 6 小时做一次"KV 全量备份到 R2"、或自动清理过期 session。

- 文档：https://developers.cloudflare.com/workers/configuration/cron-triggers/

---

## Workers AI（内置 LLM / 向量）

> **未在本项目使用**

CF 提供的内置 AI 推理服务，覆盖 LLM、文生图、Embedding、ASR 等。免费额度有限但够 demo。

```toml
[ai]
binding = "AI"
```

```js
const out = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
    prompt: '解释 BGP 工作原理',
});
```

- 文档：https://developers.cloudflare.com/workers-ai/
- 模型列表：https://developers.cloudflare.com/workers-ai/models/

---

## Vectorize（向量数据库）

> **未在本项目使用**

CF 自己的向量数据库，适合做 RAG、相似度搜索。

```js
const matches = await env.VECTORIZE.query(queryVector, { topK: 5 });
```

- 文档：https://developers.cloudflare.com/vectorize/

---

## Browser Rendering（Puppeteer）

> **未在本项目使用**

托管的 headless Chromium，用于 SSR、PDF 生成、爬虫。

```js
import puppeteer from '@cloudflare/puppeteer';
const browser = await puppeteer.launch(env.BROWSER);
const page = await browser.newPage();
await page.goto('https://example.com');
const pdf = await page.pdf();
```

- 文档：https://developers.cloudflare.com/browser-rendering/

---

## Email Routing

> **未在本项目使用**

把邮件路由到 Worker 处理，可做反垃圾、自动回复、转发。

```js
export default {
    async email(message, env, ctx) {
        await message.forward('me@example.com');
    }
};
```

- 文档：https://developers.cloudflare.com/email-routing/

---

## 速查

| 服务 | 一句话 | 何时启用 |
| --- | --- | --- |
| KV | 全球分发的 KV | **已用** |
| D1 | SQLite 数据库 | 用户量 > 千级 / 需要 join |
| R2 | S3 兼容对象存储 | 文件、备份、图片 |
| Durable Objects | 强一致单例 | 计数器、协作、限流 |
| Queues | 消息队列 | 异步任务、削峰 |
| Hyperdrive | 外部 DB 连接池 | 已有 Postgres/MySQL |
| Cron Triggers | 定时任务 | 备份、巡检 |
| Workers AI | 内置 LLM | 加 AI 功能 |
| Vectorize | 向量库 | RAG / 相似度 |
| Browser Rendering | 无头浏览器 | 爬虫、PDF |
| Email Routing | 邮件入口 | 自动处理邮件 |

更新约定：等本项目真的用上某项服务，把它从这里移出来，单独开一篇放进 framework 目录，并在 [docs/README.md](../README.md) 加链接。
