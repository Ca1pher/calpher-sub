# 订阅格式

平台同时支持三类客户端：Clash/Mihomo 系（yaml），V2RayN/V2RayNG 系（base64 聚合订阅），小火箭/Shadowrocket（也吃 base64 但单条用 `ss://`、`vmess://` 之类的 URI）。

## 公开订阅端点

| 路径 | 输出格式 | 用途 |
| --- | --- | --- |
| `/sub/<token>/clash` | mihomo yaml | Clash Verge / ClashX Pro / mihomo |
| `/sub/<token>/v2ray` | base64(全部节点) | V2RayN / V2RayNG / 小火箭 (聚合) |
| `/sub/<token>/group/<groupId>` | base64(单组) | 小火箭按组订阅 |

token 是订阅 token（subToken），不是 UUID。详见 [鉴权设计](03-auth-design.md)。

## Clash / Mihomo YAML

这是平台**最复杂**的输出。结构大致是：

```yaml
port: 10809
socks-port: 10808
allow-lan: false
mode: rule
log-level: info
ipv6: false

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver: [119.29.29.29, 223.5.5.5]
  proxy-server-nameserver: [119.29.29.29, 223.5.5.5]

proxies:
  - { name: "🇭🇰 香港-01", type: vmess, server: ..., port: ..., uuid: ..., ... }
  - { name: "⛓️ ...", type: ..., dialer-proxy: "..." }      # 链路衍生
  - ...

proxy-groups:
  - { name: "entry-自动", type: url-test, tolerance: 50, proxies: [...] }
  - { name: "🛫 入口总线", type: select, proxies: [...] }
  - { name: "🎛️ 主控", type: select, proxies: [...] }

rules:
  - DST-PORT,3478,REJECT          # WebRTC STUN
  - DST-PORT,5349,REJECT          # WebRTC STUNS
  - DOMAIN-KEYWORD,stun,REJECT
  - DOMAIN-KEYWORD,turn,REJECT
  - GEOSITE,cn,DIRECT
  - GEOIP,cn,DIRECT
  - MATCH,🎛️ 主控
```

编译实现在 `src/static/index.html` 内的 `compileYaml()` 函数，所有逻辑都在浏览器端运行，编译完整个 yaml 字符串塞到 `config.compiledYaml` 字段，整体存入 KV。

### 为什么放在浏览器端编译？

- 编译需要参考用户当前 UI 状态（拓扑/分组/链路）和动态配置（总线名、链路展开）。
- mihomo 的 proxy-groups 模型很灵活，写一份完整编译器并不轻松，放在 Worker 里会让冷启动变重。
- 浏览器端编译完直接 PUT 回 `compiledYaml`，订阅时 Worker 只负责吐字节，逻辑很薄。

**代价**：外部脚本通过 API 推节点后**不会自动重新编译 yaml**——必须用户进入管理页点一次编译保存，或者外部脚本自己拼好 `compiledYaml` 一并提交。

## V2Ray / 小火箭 (base64 聚合)

格式：`base64(节点1 URI \n 节点2 URI \n ...)`。

每条 URI 由 [`src/lib/subscription.js`](../../src/lib/subscription.js) 的 `nodeToShareLink(n)` 生成。每种协议格式不同：

| 协议 | URI 形式 |
| --- | --- |
| vmess | `vmess://base64({v,ps,add,port,id,aid,scy,net,type,host,path,tls,sni,fp})` |
| vless | `vless://<uuid>@<host>:<port>?security=tls&sni=...&type=ws&host=...&path=...#<name>` |
| ss | `ss://base64(cipher:pass)@<host>:<port>#<name>` |
| trojan | `trojan://<pass>@<host>:<port>?sni=...&type=...#<name>` |
| hysteria2 | `hysteria2://<pass>@<host>:<port>/?sni=...&insecure=1#<name>` |
| socks | `socks://[base64(user:pass)@]<host>:<port>#<name>` |

### "⛓️ 衍生节点" 不出现在 base64 里

链路衍生节点是 mihomo 独有概念（依赖 `dialer-proxy`），v2ray 协议没有原生表达方式。所以 `buildShareLinks()` 在生成 base64 列表时主动过滤：

```js
const physicalNodes = nodes.filter(
    n => !(n && typeof n.name === 'string' && n.name.startsWith('⛓️'))
);
```

如果你想让 V2RayN 用户也用链路，目前没办法——这是协议差异决定的，不是平台限制。

### 单组订阅 `/sub/<token>/group/<groupId>`

只输出该分组下的物理节点。常用于小火箭把不同地区分到不同订阅 URL，UI 上按订阅分类。

## base64 编码注意

```js
// src/lib/subscription.js
function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}
```

`btoa` 本身不接受非 ASCII（节点名常带中文/emoji），所以先 `encodeURIComponent` 转 UTF-8 percent-encoding，再 `unescape` 转 binary string，最后 `btoa`。这是标准的 "btoa unicode" workaround。

## 客户端订阅刷新建议

| 客户端 | 自动刷新间隔 |
| --- | --- |
| Clash Verge | 默认 24h，可手动改到 1h |
| V2RayN | 手动 |
| 小火箭 | 配置里可选自动间隔 |
| mihomo CLI | 看 `external-controller` 命令调用 |

外部脚本推完节点后，最好告诉用户在客户端手动刷一下订阅——KV 最终一致 + 客户端不实时拉，"立刻看到新节点" 的链路要打通。
