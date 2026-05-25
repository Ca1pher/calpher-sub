# Calpher Sub 项目文档

本目录是 calpher-sub 的学习型文档，按"业务"与"框架"两条主线组织。每篇都是独立 markdown，可以按需阅读。

## 业务（实现 / 设计）

聚焦本项目的产品功能与核心算法。如果你只是想理解"这个订阅平台是怎么跑起来的"，从这里开始。

| 文档 | 主题 |
| --- | --- |
| [业务总览](business/01-overview.md) | 我们要解决什么问题、典型工作流 |
| [KV 数据模型](business/02-data-model.md) | 4 类 key 的形态、写入路径、读取路径 |
| [鉴权设计](business/03-auth-design.md) | UUID 同时作身份与外部 token、cookie session、subToken 隔离 |
| [节点编排模型](business/04-node-topology.md) | 物理节点 / 逻辑分组 / 入口·中转·出口·主控总线 |
| [订阅格式](business/05-subscription-formats.md) | Clash/Mihomo YAML、V2Ray base64 聚合、小火箭 |
| [节点去重 (指纹)](business/06-dedup.md) | 为什么用指纹去重而不是 id 去重 |
| [WebRTC 防泄漏与 YAML 加固](business/07-webrtc-hardening.md) | 4 项 mihomo 配置加固的来由 |

## 框架（Cloudflare Workers）

聚焦运行时——本项目用到的 CF 平台能力，以及我们暂未使用但可以参考的相邻服务。

| 文档 | 主题 |
| --- | --- |
| [Workers 简介](framework/01-cf-worker-intro.md) | 什么是 Worker、与传统后端的差异、我们用到了哪些能力 |
| [项目初始化与 wrangler](framework/02-project-setup.md) | wrangler CLI、`wrangler.toml`、本地开发 |
| [KV 存储](framework/03-kv-storage.md) | KV 创建、绑定、读写模式、与本项目的映射 |
| [Secret 与环境变量](framework/04-secrets-and-vars.md) | `wrangler secret put`、`.dev.vars`、`[vars]` 的取舍 |
| [部署流程](framework/05-deploy.md) | `wrangler deploy`、Cloudflare 路由、自定义域 |
| [静态资源打包](framework/06-static-bundling.md) | 我们怎么把 `index.html` 打进 worker bundle |
| [其他存储与服务](framework/07-other-storage.md) | D1 / R2 / Durable Objects / Queues / Hyperdrive 速览 + 官方链接 |

## 文档维护约定

- **后续用到新的 CF 服务**：补一段进 [其他存储与服务](framework/07-other-storage.md)，沉淀过后单独拆一篇。
- **业务发生大变化**：先更新 [业务总览](business/01-overview.md)，再修对应专题。
- **代码示例**：尽量从 `src/` 摘真实片段，不要写演示用伪代码——避免文档与实现漂移。
