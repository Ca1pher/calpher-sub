# KV 数据模型

Cloudflare KV 是一个全球分发的、最终一致的键值存储。本项目所有持久化数据都落在一个名为 `CALPHER_KV` 的 namespace 上，用前缀划分 4 类 key。

## 四类 Key

| Prefix | Key | Value | 来源 |
| --- | --- | --- | --- |
| `user:` | `user:<uuid>` | `{ uuid, name, role, createdAt, subToken? }` | 用户 CRUD / admin bootstrap |
| `config:` | `config:<uuid>` | `{ nodes, groups, busNames, compiledYaml, updatedAt }` | 节点/分组 CRUD + 整体保存 |
| `subtoken:` | `subtoken:<token>` | `<uuid>` (纯字符串, 反向索引) | 首次推节点 / 手动重置 |
| `session:` | `session:<sid>` | `<uuid>` (TTL 30 天) | UUID 登录后写入 |

key 规范定义在 [`src/lib/kv.js`](../../src/lib/kv.js)：

```js
const PREFIX = {
    USER: 'user:',
    CONFIG: 'config:',
    SUBTOKEN: 'subtoken:',
    SESSION: 'session:',
};
```

## 为什么这样切

### `user:<uuid>` — 主用户表
- 以 UUID 为主键。Cloudflare KV 不支持二级索引，列表查询通过 `kv.list({ prefix: 'user:' })` 全扫（用户量量级在几十到几百时完全够用）。
- `role` 字段决定权限：`admin` 可越权操作他人 config；`user` 只能动自己的。

### `config:<uuid>` — 配置主体
- 每个用户的节点/分组/总线/编译后 yaml 全部塞在一个 JSON 里，整体写。
- 这是个**故意的取舍**：mihomo yaml 几十到几百 KB，KV 的写操作配额按"次"计（免费 1000/天），整体写比拆字段更省。
- 缺点：并发修改会有写竞争，但本项目是单用户编辑场景，可以接受。

### `subtoken:<token>` — 公开订阅反查
- 公开订阅 URL 长这样：`/sub/<token>/clash`
- 我们用 token（16 字节随机）而不是 UUID，是因为：
  - **泄露隔离**：subToken 泄露只暴露订阅内容，不会让人能登录后台；UUID 泄露则等于失去账号。
  - **可独立重置**：用户在前台点"重置 token"，旧链接立即失效，UUID 不变。

### `session:<sid>` — 登录态
- 32 字节随机 hex（`crypto.randomUUID().replace(/-/g, '') × 2`）。
- 30 天 TTL，KV 原生支持 `expirationTtl` 自动过期，无需自己清理。
- cookie 名 `cs_sid`，HttpOnly + SameSite=Lax + Secure（生产）。

## 写入路径

### 整体保存 (PUT `/api/config`)
1. 收到 body，校验权限（自己或 admin）。
2. 读旧 config（用于指纹去重比对）。
3. `dedupConfigAgainstExisting(incoming, old, uuid)` —— 详见 [指纹去重](06-dedup.md)。
4. 如果新 nodes 非空且用户没 subToken，签发一个新 subToken：
   - `setSubToken(kv, token, uuid)` 写反向索引
   - 更新 `user:<uuid>.subToken`
5. `putConfig(kv, uuid, sanitized)` 整体写回。

### 细粒度 CRUD (`/api/v1/nodes/...` / `/api/v1/groups/...`)
- 都遵循"读完整 config → 改局部 → 走 `persistConfig` → 整体写回"的模式，见 [`src/handlers/crud.js`](../../src/handlers/crud.js)。
- 看上去"细粒度"，实现上其实是粗粒度——这是 KV 没有事务能力下的简化方案。

### 删除用户 (`DELETE /api/users/<uuid>`)
管理员删用户时需要清理 4 个 key：
- `user:<uuid>`
- `config:<uuid>`
- `subtoken:<旧 token>`（如果有）
- 不用清 `session:<sid>`——TTL 自动过期，下次访问时 `getUser` 返回 null 就会失败鉴权

## 读取路径

### 公开订阅 (`/sub/<token>/clash`)
1. `getSubTokenOwner(kv, token)` → `uuid`
2. `getUser(kv, uuid)` → 校验用户存在（防止已被删除但 token 残留的情况）
3. `getConfig(kv, uuid)` → 取出 `compiledYaml`，直接吐出

### 登录 (`POST /api/auth/login`)
1. 校验 body 的 UUID 格式
2. `getUser(kv, uuid)` 必须存在
3. 生成 sid → `setSession(kv, sid, uuid, ttl: 30d)`
4. 写 cookie

## 性能注意

| 操作 | 复杂度 | 备注 |
| --- | --- | --- |
| 单用户读 config | 1 次 KV.get | 通常 < 50ms |
| 用户列表 (admin) | N+1 次 KV.get (list + 逐个 get) | N 大时考虑批量, 当前实现见 `listUsers` |
| 公开订阅 | 3 次 KV.get | subToken→user→config |
| 保存 config | 1~3 次 KV.put | config + (可选)subToken + user |

KV **最终一致**：写入后全球节点可能延迟几秒同步。对本项目而言：
- 同一用户改完立刻拉订阅，**可能拉到旧版**——客户端订阅刷新本身就有间隔，可接受。
- admin 改完另一台机器看，可能慢几秒，能接受。
- 若不能接受，考虑改用 [Durable Objects](../framework/07-other-storage.md#durable-objects) 或 D1。
