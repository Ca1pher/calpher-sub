# 节点编排模型

本项目最有"业务感"的部分。我们把单条物理节点抽象成"节点 → 分组 → 总线 → 主控"四层，编排到 mihomo yaml 里。

## 四层模型

```
              ┌─────────────────────────────────┐
              │       主控 (master)              │
              │   规则匹配后最终选的策略组         │
              └─────────────┬───────────────────┘
                            │ select
              ┌─────────────┴───────────────────┐
              │       三大总线 (bus)             │
              │   入口总线 / 出口总线 / 矩阵      │
              └─────────────┬───────────────────┘
                            │ select
              ┌─────────────┴───────────────────┐
              │       分组 (group)               │
              │   entry / common / exit / relay │
              └─────────────┬───────────────────┘
                            │ url-test / select
              ┌─────────────┴───────────────────┐
              │       节点 (node)                │
              │   vmess / vless / ss / trojan…  │
              └─────────────────────────────────┘
```

| 层级 | 在 mihomo 里对应 | 由谁创建 |
| --- | --- | --- |
| **节点 (node)** | `proxies[]` 的一项 | 用户手动添加 / 外部脚本推入 |
| **分组 (group)** | `proxy-groups[]` 的一项 (url-test / select) | 用户配置 |
| **总线 (bus)** | `proxy-groups[]` 的一项 (select) | 自动生成，名字可改 |
| **主控 (master)** | `proxy-groups[]` 的一项 (select) | 自动生成，名字可改 |

## 节点 (node)

最底层。基本字段：

```js
{
    id: "n-xxx",
    name: "🇭🇰 香港-01",
    type: "vmess",        // vmess / vless / ss / trojan / hysteria2 / socks
    server: "1.2.3.4",
    port: 443,
    // 协议相关字段:
    uuid: "...",          // vmess/vless
    cipher: "auto",       // vmess/ss
    pass: "...",          // ss/trojan/hy2/socks
    user: "...",          // socks
    network: "ws",        // 传输层
    tls: true,
    sni: "example.com",
    host: "example.com",
    path: "/ws",
    // ...
}
```

## 分组 (group)

把若干节点按业务含义放到一起，并给一个角色（role）：

| role | 含义 | 在 yaml 里的形态 |
| --- | --- | --- |
| `entry` | 入口节点 (链路第一跳 / 国内中转) | `url-test` + 可选"个体"暴露 |
| `common` | 普通分组 (默认) | `url-test` |
| `exit` | 出口节点 (链路最后一跳 / 落地) | `url-test` |
| `relay` | 链路组 (entry × exit 笛卡尔积) | 自动生成的"⛓️" 衍生节点 |

`url-test` 会让 mihomo 定期 `HEAD http://www.gstatic.com/generate_204` 测延迟，自动选最快的；加 `tolerance: 50` 防止两个节点延迟相近时反复切换（见 [WebRTC 防泄漏与 YAML 加固](07-webrtc-hardening.md)）。

### Relay 分组（链路）

最复杂的一类。一个 relay 分组只填两个引用：

```js
{ id, name, role: 'relay', entryGroupId: 'g-entry', exitGroupId: 'g-exit', nodes: [] }
```

编译时会自动展开为 `entry × exit` 的所有组合，每个组合是一个"⛓️ 衍生节点"（mihomo 通过 `dialer-proxy` 实现节点串联）。这些衍生节点：
- 不会出现在 v2ray 分享链接里（只服务于 mihomo）。
- 名字以 `⛓️` 开头标识。
- `lib/subscription.js` 在生成 v2ray base64 时主动过滤掉。

## 总线 (bus)

三条总线，把所有分组聚合到一个 `select` 策略组里，方便客户端 UI 上一键切换：

| 总线 | 默认名 | 包含 |
| --- | --- | --- |
| 入口总线 | `🛫 入口总线` | 所有 entry 分组 |
| 出口总线 | `🛬 出口总线` | 所有 exit 分组 + relay 分组 |
| 矩阵 | `🌐 总矩阵` | 所有节点（不分组） |

总线名可在管理页改，但客户端订阅时 yaml 里写的就是这个名字——改完一定要重新编译并保存。

## 主控 (master)

唯一的"规则命中点"。yaml 里所有 `MATCH,xxx` 都指向这个。它的成员是三大总线 + 各组的 url-test + DIRECT + REJECT，全部塞进一个 `select`。

```yaml
- name: "🎛️ 主控"
  type: select
  proxies:
    - 🛬 出口总线
    - 🛫 入口总线
    - 🌐 总矩阵
    - entry-自动 / entry-自动 / ...   # 各分组的 url-test
    - DIRECT
    - REJECT
```

用户在客户端代理面板看到的"主控"就是这个，可以临时切到 DIRECT 调试。

## 编译流程

1. **校验**：每个 group 角色合法、relay 的 entry/exit 引用存在、节点 id 引用有效。
2. **生成 proxies**：物理节点 → mihomo 风格 yaml，再追加 relay 展开的衍生节点。
3. **生成 proxy-groups**：分组 url-test + relay 链路组 + 三大总线 + 主控。
4. **生成 dns / rules / 加固项**：见 [WebRTC 防泄漏与 YAML 加固](07-webrtc-hardening.md)。
5. **拼成完整 yaml 字符串**：存到 `config.compiledYaml`，订阅时直接吐出。

> 编译完整在浏览器端（`src/static/index.html` 的 `compileYaml()` 函数）做。Worker 不参与编译——主要是为了避免在 Worker 里维护一份完整的 mihomo 编译器。

## 命名规则

- 节点名：用户自取，建议加国旗 emoji 方便客户端 UI 识别。
- 分组名：用户自取。
- 衍生节点名：`⛓️ <entry.name> → <exit.name>`，自动生成。
- 总线/主控名：默认带 emoji，全程可改，存在 `config.busNames`。

## 与外部脚本的协作

外部脚本（如签到机器人）通常只关心节点：
- 用 `POST /api/v1/nodes` 推一批新节点。
- 在 body 里可以指定 `groupIds: [...]` 让节点自动塞进某个分组。
- 平台自动按指纹去重，旧节点的 id+name 保留（**这一点保证订阅链接稳定**）。

至于分组、总线、主控、链路——通常人工建一次就行，外部脚本不动。
