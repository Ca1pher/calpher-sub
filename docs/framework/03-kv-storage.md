# KV 存储

Workers KV 是 CF 提供的**全球只读复制、写入最终一致**的键值存储。本项目所有持久化数据都在 KV 上。

## 一句话特性

- **键最大 512 字节，值最大 25 MB**。
- **全球读：边缘节点本地命中 <10ms**；首次读源会去源节点。
- **全球写：60 秒级最终一致**。
- **TTL 原生支持**（按秒）。
- **list 接口**：按前缀分页扫描。
- **没有事务、没有原子计数、没有索引**——这些需求请用 Durable Objects 或 D1。

## 创建 KV namespace

```bash
npx wrangler kv namespace create CALPHER_KV
npx wrangler kv namespace create CALPHER_KV --preview
```

两条命令分别创建：

- 生产用的 namespace → 返回 `id`
- 本地 `wrangler dev --remote` 用的预览 namespace → 返回 `preview_id`

把它们填到 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CALPHER_KV"
id = "<your-namespace-id>"
preview_id = "<your-preview-id>"
```

- `binding`：在 Worker 代码里通过 `env.CALPHER_KV` 访问。
- `id` / `preview_id`：CF 后端的实际 namespace UUID。

> `binding` 名是你自己起的，但代码里全部都得用它（`env.CALPHER_KV`）。改名时同步改两边。

## API（Worker 内）

```js
// 读
await env.CALPHER_KV.get(key)                      // string
await env.CALPHER_KV.get(key, 'json')              // 自动 JSON.parse
await env.CALPHER_KV.get(key, 'arrayBuffer')       // 二进制
await env.CALPHER_KV.get(key, { cacheTtl: 3600 })  // 边缘缓存 1h

// 写
await env.CALPHER_KV.put(key, value)                          // string/ArrayBuffer/ReadableStream
await env.CALPHER_KV.put(key, value, { expirationTtl: 60 })   // 60 秒后过期
await env.CALPHER_KV.put(key, value, { expiration: 1735689600 }) // 绝对时间戳
await env.CALPHER_KV.put(key, value, { metadata: {...} })      // 附加元数据 (<= 1KB)

// 删
await env.CALPHER_KV.delete(key)

// 列表
const page = await env.CALPHER_KV.list({
    prefix: 'user:',
    limit: 1000,           // 默认 1000
    cursor: '...',         // 分页游标
});
// page.keys: [{ name, expiration?, metadata? }, ...]
// page.list_complete: boolean
// page.cursor: 下一页游标
```

## 本项目的 KV 用法

定义集中在 [`src/lib/kv.js`](../../src/lib/kv.js)：

```js
const PREFIX = {
    USER: 'user:',
    CONFIG: 'config:',
    SUBTOKEN: 'subtoken:',
    SESSION: 'session:',
};

export const kvKey = {
    user: uuid => PREFIX.USER + uuid,
    config: uuid => PREFIX.CONFIG + uuid,
    subToken: token => PREFIX.SUBTOKEN + token,
    session: sid => PREFIX.SESSION + sid,
};
```

四类 key 详细见 [KV 数据模型](../business/02-data-model.md)。

### 常见模式 1：JSON 编解码

```js
export async function getUser(kv, uuid) {
    const raw = await kv.get(kvKey.user(uuid));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { ... }
}
export async function putUser(kv, user) {
    await kv.put(kvKey.user(user.uuid), JSON.stringify(user));
}
```

> 也可以 `kv.get(key, 'json')` 一步到位，我们手写是为了把解析失败的日志打详细些。

### 常见模式 2：自动过期

session 用 30 天 TTL，到期后 KV 自动删，省得自己写清理逻辑：

```js
await kv.put(kvKey.session(sid), uuid, { expirationTtl: 60 * 60 * 24 * 30 });
```

### 常见模式 3：列表 + 分页

```js
export async function listUsers(kv) {
    const out = [];
    let cursor;
    do {
        const page = await kv.list({ prefix: PREFIX.USER, cursor, limit: 1000 });
        for (const k of page.keys) {
            const u = await getUser(kv, k.name.slice(PREFIX.USER.length));
            if (u) out.push(u);
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
}
```

> ⚠️ `list` 只返回 key 名，不返回 value。要拿 value 必须再 `get` 一遍——会消耗读配额。我们这里 N+1 次读，用户量级在百级以下完全够用；如果到万级，建议把"列表展示需要的字段"塞进 `metadata`，`list` 一次拿全。

## 本地开发与 KV

`wrangler dev` 默认用本地模拟（miniflare），数据存在 `.wrangler/state/` 目录。

切换模式：

```bash
npm run dev              # 默认 --local, 用模拟 KV
npm run dev -- --remote  # 直连远程 preview_id 那个 KV
```

第一次连远程会拉真实数据，方便调试生产问题。

## 远程操作 KV（不进 Worker）

调试或运维时可以从命令行直接读写：

```bash
# 列出 namespace
npx wrangler kv namespace list

# 看某 key
npx wrangler kv key get --binding=CALPHER_KV 'user:xxx-xxx'

# 写
npx wrangler kv key put --binding=CALPHER_KV 'foo' 'bar'

# 删
npx wrangler kv key delete --binding=CALPHER_KV 'foo'

# 批量删 (危险)
npx wrangler kv bulk delete --binding=CALPHER_KV keys.json
```

加 `--preview` 操作预览 namespace。

## 性能与成本提示

- **读优先于写**：免费版 100k 读 / 1k 写 / 天，差 100 倍。优化方向永远是"少写"。
- **大对象 vs 小对象**：写次数比 byte 重要——本项目把 `nodes/groups/compiledYaml` 全部塞进一个 `config:<uuid>` 而非拆字段，就是这个考虑。
- **缓存**：`get` 可加 `cacheTtl` 让边缘缓存更久，对很热的 key 有用。
- **最终一致延迟**：写后立刻读，**有概率读到旧值**，特别是不同区域的读。本项目"保存配置 + 刷新订阅"间隔通常足够长，没问题。

## 官方文档

- KV 概览：https://developers.cloudflare.com/kv/
- API 参考：https://developers.cloudflare.com/kv/api/
- 限制：https://developers.cloudflare.com/kv/platform/limits/
- 价格：https://developers.cloudflare.com/kv/platform/pricing/
