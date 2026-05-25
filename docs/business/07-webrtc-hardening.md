# WebRTC 防泄漏与 YAML 加固

编译产出的 mihomo yaml 默认开启了 4 项加固。本篇解释每一项的来由、副作用，以及"为什么 WebRTC 那条要做成开关"。

## 加固项一览

| 项 | 配置 | 是否可关 |
| --- | --- | --- |
| 1. 禁用 LAN 监听 | `allow-lan: false` | 默认强制 |
| 2. 代理服务器域名独立 DNS | `dns.proxy-server-nameserver` | 默认强制 |
| 3. URL-Test 抖动抑制 | `proxy-groups[*].tolerance: 50` | 默认强制 |
| 4. 拦截 WebRTC STUN/TURN | 规则段 4 条 REJECT | **UI 开关，默认开** |

## 1. `allow-lan: false`

**作用**：mihomo 默认不监听 LAN 接口（仅 127.0.0.1）。

**为什么**：开启后任何同网段的人都能用你的代理。家庭/咖啡厅 wifi 都不安全。

**副作用**：手机、平板、Apple TV 等设备不能通过你的 mihomo 走代理——但本项目场景是"每台设备各自跑客户端"，不存在这种需求。需要时用户自己把整段 yaml 拷出来改。

## 2. `dns.proxy-server-nameserver`

**作用**：单独指定一组 DNS 解析"代理服务器自身"的域名（例如订阅里节点 server 是 `vpn.example.com`，而不是裸 IP）。

```yaml
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver: [119.29.29.29, 223.5.5.5]
  proxy-server-nameserver: [119.29.29.29, 223.5.5.5]   # ← 加固项
```

**为什么**：mihomo 开启 fake-ip 后所有域名解析返回 `198.18.x.x` 假 IP，让规则引擎根据假 IP 匹配规则。但**代理服务器自己的域名**如果也被解析成 fake-ip，连不上！`proxy-server-nameserver` 强制这些域名走真实 DNS。

**副作用**：基本无。我们的默认 DNS 是腾讯 119.29.29.29 和阿里 223.5.5.5，国内可达。

**典型踩坑**：本项目部署后用 `wrangler dev`，连 `api.cloudflare.com` 也被解析成 198.18.x.x → 连接超时。如果你看到类似 `EHOSTUNREACH 198.18.1.91:443`，先怀疑这个。

## 3. `url-test` 加 `tolerance: 50`

**作用**：mihomo 的 url-test 策略组会定期测延迟，自动选最快的节点。`tolerance: 50` 表示"新节点必须比当前节点快 50ms 以上才切换"，否则保持。

```yaml
- name: "auto-香港"
  type: url-test
  url: "http://www.gstatic.com/generate_204"
  interval: 300
  tolerance: 50              # ← 加固项
  proxies: [...]
```

**为什么**：两个节点延迟相近时，没有 tolerance 会出现"每 5 分钟切一次"的抖动，长连接被反复打断。

**副作用**：可能在某节点已经从 80ms 涨到 200ms 时仍坚持用它，直到差距 > 50ms 才切。**对网游等延迟敏感场景影响较大，对网页/视频几乎无感**。

## 4. 拦截 WebRTC STUN/TURN（**默认开，可关**）

**作用**：在 rules 段开头插 4 条 REJECT 规则：

```yaml
rules:
  - DST-PORT,3478,REJECT       # STUN 标准端口
  - DST-PORT,5349,REJECT       # STUNS (TLS STUN) 标准端口
  - DOMAIN-KEYWORD,stun,REJECT
  - DOMAIN-KEYWORD,turn,REJECT
  - GEOSITE,cn,DIRECT
  ...
```

**为什么**：浏览器 WebRTC 会用 STUN 协议探测**你的真实公网 IP**——即使你开了代理！STUN 走 UDP，且很多代理不转发 UDP，浏览器拿到的就是裸 IP。常见于：

- Discord 网页版语音
- Google Meet
- Zoom 网页版
- 各种"网页测 IP"工具会同时 leak

**副作用**：

| 场景 | 影响 |
| --- | --- |
| 浏览器语音/视频会议 | ❌ 通话建立不了 |
| 桌面版 Zoom/Teams/微信 | ✅ 无影响（用自己协议，不走 STUN） |
| 普通网页/视频/下载 | ✅ 无影响 |
| 游戏 | ✅ 通常无影响（极少数 P2P 游戏除外） |

因为只有"浏览器视频会议"会受影响，平台把它做成 UI 开关：

```html
<input type="checkbox" id="opt-block-webrtc" checked
       onchange="onCompileOptionChange()" />
<label>防 WebRTC IP 泄漏 (浏览器视频会议会失效)</label>
```

用户取消勾选 → 4 条 REJECT 不写进 yaml → 浏览器 WebRTC 恢复，但 IP 可能泄漏。

### 持久化

勾选状态存在浏览器 `localStorage` 的 `calpher.compileOptions` key：

```js
const COMPILE_OPT_KEY = 'calpher.compileOptions';
function restoreCompileOptions() { /* 读 localStorage, 写入 checkbox */ }
function onCompileOptionChange() { /* 写 localStorage */ }
```

> **跨设备不同步**：localStorage 只在当前浏览器，换设备需要重新勾。如果之后觉得需要同步，可以把这个偏好挪到 `config.busNames` 同级（KV 跟随用户走）。

## 验证方式

部署后，打开管理页，点编译，看生成的 yaml：

1. 检查头部有 `allow-lan: false`。
2. 检查 dns 段有 `proxy-server-nameserver`。
3. 检查任一 url-test 组有 `tolerance: 50`。
4. 检查 rules 段头部有 4 条 REJECT（如果勾选了 WebRTC 防护）。
5. 取消勾选 → 重新编译 → 4 条 REJECT 消失。

WebRTC 泄漏自测：勾选+编译+订阅生效后，打开 https://browserleaks.com/webrtc，应该看不到你的真实 IP。
