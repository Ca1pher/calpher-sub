# 节点去重 (指纹)

外部脚本经常会重复跑（比如机场签到每天一次，每次都 push 同一批 IP）。如果按节点 `id` 判重，每次新生成的 id 都不同 → 节点表无限增长，订阅膨胀。所以我们用**指纹去重**。

## 指纹定义

实现：[`src/lib/dedup.js`](../../src/lib/dedup.js) 的 `nodeFingerprint(n)`。

```js
function nodeFingerprint(n) {
    if (!n || !n.type) return '';
    const t = String(n.type).toLowerCase();
    const host = String(n.server || '').toLowerCase().trim();
    const port = parseInt(n.port) || 0;
    let auth = '';
    if (t === 'vmess' || t === 'vless') {
        auth = (n.uuid || '').trim();
    } else if (t === 'ss' || t === 'shadowsocks') {
        auth = (n.cipher || '') + ':' + (n.pass || '');
    } else if (t === 'trojan' || t === 'hysteria2' || t === 'hy2') {
        auth = (n.pass || '');
    } else if (t === 'socks' || t === 'socks5') {
        auth = (n.user || '') + ':' + (n.pass || '');
    } else {
        auth = JSON.stringify(n);
    }
    return `${t}|${host}|${port}|${auth}`;
}
```

指纹由 4 段组成：

```
<type>|<host>|<port>|<auth>
```

`auth` 因协议而异——挑该协议**真正的身份凭证**：vmess/vless 是 uuid，ss 是 cipher+pass，trojan/hy2 是 pass，socks 是 user+pass。

## 为什么这么挑字段

| 字段 | 进指纹 | 理由 |
| --- | --- | --- |
| type | ✅ | 不同协议的节点必然不同 |
| server | ✅ | IP/host 是身份核心 |
| port | ✅ | 同 host 多端口算多节点 |
| 协议凭证 (uuid/cipher+pass/pass) | ✅ | 同一服务器换密码 = 不同节点 |
| name | ❌ | 用户/脚本会改名，但节点其实是同一个 |
| sni / host / path / network | ❌ | 传输层配置，同一节点常有多组等价配置 |
| tls / fingerprint 等 | ❌ | 同上 |
| id | ❌ | 客户端自生成，没有意义 |

**关键判断**：网管在机场后台改了 sni 或 ws-path，但 ip:port:uuid 不变 → 我们认为还是同一个节点，**只更新非凭证字段**。

## 去重算法

```
incoming.nodes 与 oldConfig.nodes 做指纹比对:

for inc in incoming.nodes:
    fp = nodeFingerprint(inc)
    if fp 已在 incoming 内部出现过:
        把 inc.id 映射到第一次出现的那个 inc.id, 跳过
    else if fp 在 oldConfig 中存在:
        保留 old 的 id + name, 其他字段用 incoming 的
        记录 idMap[inc.id] = old.id
    else:
        作为新节点加入
        记录 idMap[inc.id] = inc.id

incoming.groups[].nodes[] 全部经过 idMap 翻译, 再去重保序
```

实现见 [`dedupConfigAgainstExisting`](../../src/lib/dedup.js)。

## 三种典型场景

### 场景 1：脚本重复推同一节点

```
旧 nodes: [{id: 'old-1', name: '🇭🇰 香港', server:'1.1.1.1', port:443, ...uuid}]
新推:     [{id: 'auto-2026-01', name: 'Acc1_N1_HK', ...同 server/port/uuid...}]
结果:     [{id: 'old-1', name: '🇭🇰 香港', ...新字段...}]  # id/name 保留, 其他更新
```

订阅 URL 不变，客户端不会感知到节点列表变化——只是节点 ip/port 之外的细节可能微调。

### 场景 2：节点真的换了

```
旧 nodes: [{server:'1.1.1.1', port:443, uuid:'AAA'}]
新推:     [{server:'1.1.1.1', port:443, uuid:'BBB'}]   # 同 host:port 换了 uuid
结果:     [..., {id:'new', server:'1.1.1.1', port:443, uuid:'BBB'}]   # 作为新节点加
```

老节点保留在表里（订阅依然包含），新节点也加进来。**这是有意的**——避免脚本一抽风把所有真节点删光。需要清理时让用户手动删。

### 场景 3：同一批 incoming 里自己重复

机场可能因为 LB 把同一节点返回两条。指纹去重在 incoming 内部就完成，不会写入两份。

## 浏览器端的等价实现

`index.html` 内部也有一份 `nodeFingerprint()`，逻辑必须与 `lib/dedup.js` 完全一致——保存时浏览器先做一次本地去重渲染。

> ⚠️ 修改指纹算法时**两边都要改**。后续考虑把浏览器端的实现改成调用 API 拿到去重结果再渲染，避免这种"双实现一致性"负担。

## 局限

- 指纹不考虑 sni/path/网络层差异。**这是有意的**——但若你需要把 `1.1.1.1:443/ws` 和 `1.1.1.1:443/grpc` 当成不同节点，当前算法做不到。
- 不存历史。被覆盖的字段无法恢复。
- 不会自动清理"long dead"节点（多次推送都没出现）。如要做，需要加 lastSeen 时间戳 + 定时清理。
