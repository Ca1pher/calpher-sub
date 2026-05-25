# 业务总览

## 一句话

**给一组人共享一个"管 Clash/V2Ray 节点的小后台"**——管理员开 UUID、用户用 UUID 登录、各自维护节点与分组、平台编译出标准订阅链接，客户端订阅即用。

## 解决的核心问题

如果你只手里抓着一堆 ss/vmess 节点，自己写 mihomo yaml 已经够麻烦了；当出现下面任何一种情况，就需要一个"订阅编排器"：

1. **多人共享节点**：管理员一份节点，多个家人 / 设备 / 朋友各自有不同的分组偏好。
2. **多协议同时分发**：同一份节点要给 Clash 用（yaml），又要给 v2rayN / 小火箭 用（base64）。
3. **节点经常变**：拿到新节点想直接更新订阅，但不想让客户端重新填账号——保持订阅 URL 不变。
4. **链路编排**：想把"入口节点 → 中转节点 → 出口节点"组合成自定义链路（mihomo 的 `dialer-proxy`）。
5. **外部脚本批量推节点**：例如签到机器人定时抓节点，要能通过 API 一键写回平台。

## 关键概念速览

| 概念 | 含义 |
| --- | --- |
| **用户** | 一枚 UUID 就是一个用户。无密码登录，UUID 同时是外部 API 的 Bearer token |
| **admin** | 由环境变量 `ADMIN_UUID` 引导出的超级管理员，可建/删用户、改任意用户配置 |
| **节点 (node)** | 一条物理代理：vmess/vless/ss/trojan/hysteria2/socks |
| **分组 (group)** | 一组节点的逻辑集合，带角色（entry/common/exit/relay） |
| **总线 (bus)** | 由分组组合而成的策略选择器：入口总线、出口总线、主控总线 |
| **订阅 token (subToken)** | 与 UUID 隔离的公开订阅链接 token，泄露时可单独重置 |
| **compiledYaml** | 浏览器端编译出的完整 mihomo yaml，存在 KV，订阅时直接吐出 |

## 典型工作流

### 管理员视角

```
1. wrangler secret put ADMIN_UUID  →  写入一枚自己的 UUID
2. wrangler deploy
3. 打开主页, 用 admin UUID 登录
4. 新建普通用户  →  分发 UUID 给对方
5. 自己维护节点/分组/总线  →  编译 yaml  →  保存
6. 复制订阅链接给客户端使用
```

### 普通用户视角

```
1. 拿到 admin 给的 UUID
2. 打开主页, 输入 UUID 登录
3. 维护自己的节点/分组
4. 编译 yaml + 保存
5. 客户端导入 /sub/<token>/clash 即可
```

### 外部脚本视角

```
1. 从机场签到拿到节点列表
2. 用 Bearer <UUID> 调 POST /api/v1/nodes  逐条推入
3. 平台自动按指纹去重, id+name 不变 → 订阅 URL 保持稳定
4. 用户端订阅自动更新
```

> 实际我们已经写了一个 ip2free 的签到示例脚本（不在 git 仓库中，是私有运维资产），逻辑就是上面这套。

## 模块组成

```
src/
├── index.js                  # Worker 入口 + 路由
├── handlers/                 # HTTP 处理器
│   ├── _resp.js              # 统一响应封装 (json/badRequest/notFound...)
│   ├── users.js              # 用户 CRUD (admin only)
│   ├── config.js             # 整体 config 读写 + subToken 轮换
│   ├── crud.js               # 节点/分组 细粒度 CRUD (/api/v1)
│   └── sub.js                # 公开订阅出口 /sub/<token>/...
├── lib/                      # 业务库
│   ├── auth.js               # 登录 / cookie / Bearer / admin bootstrap
│   ├── kv.js                 # KV key 规范 + getX/putX 封装
│   ├── dedup.js              # 节点指纹与去重
│   ├── subscription.js       # v2ray 分享链接序列化
│   └── uuid.js               # UUID 校验 + token 生成
└── static/
    └── index.html            # 单页 SPA + Clash YAML 编译器 (核心交互全在这)
```

业务复杂度集中在三处：
1. **`static/index.html` 中的 YAML 编译器**——节点 + 分组 + 链路 → 完整 mihomo yaml，需要懂 mihomo 的 proxy-groups 模型。
2. **`lib/dedup.js`**——指纹算法，决定外部脚本反复推节点时订阅链接稳定与否。详见 [节点去重](06-dedup.md)。
3. **`handlers/sub.js`**——公开订阅出口，没有登录态，仅靠 subToken 鉴权，是平台的"对外面"。

## 下一步阅读

- 想理解数据怎么存：[KV 数据模型](02-data-model.md)
- 想理解登录怎么做的：[鉴权设计](03-auth-design.md)
- 想理解节点编排：[节点编排模型](04-node-topology.md)
