// 把工作区 nodes/groups 序列化成 v2ray/小火箭可识别的分享链接列表
// 与浏览器端 nodeToShareLink() 保持一致

function b64encode(str) {
    // unescape(encodeURIComponent(...)) -> binary safe before btoa
    return btoa(unescape(encodeURIComponent(str)));
}
// SIP002: ss URL 的 userinfo 用 URL-safe 无 padding base64
function b64encodeUrlSafe(str) {
    return b64encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// 强制把 ()!'*等 encodeURIComponent 漏掉的字符也 percent-encode (clash/v2rayN 解析 fragment 时更稳)
function encodeFragment(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// 对节点数组做规范化序列化并取 SHA-256,用于校验缓存的 compiledYaml 是否仍与当前节点一致。
// 每次保存时写入 compiledNodesHash,clash 订阅端用它与当前节点比对,不一致就判定缓存过期。
export async function nodesHash(nodes) {
    const canonical = (Array.isArray(nodes) ? nodes : []).map(n => {
        const copy = Object.assign({}, n);
        delete copy.id;
        delete copy._clashName;
        return copy;
    });
    const json = JSON.stringify(canonical);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 把 "mode: websocket, host: foo, path: \"/bar\", tls: true" 解析为对象
function parsePluginOpts(s) {
    const out = {};
    if (!s) return out;
    for (const pair of String(s).split(',')) {
        const ci = pair.indexOf(':');
        if (ci === -1) continue;
        const k = pair.slice(0, ci).trim();
        const v = pair.slice(ci + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k) out[k] = v;
    }
    return out;
}

// 按 SIP002 把 ss plugin + plugin-opts 拼成 ?plugin= 参数体
// 只输出 mode/host/path/tls/mux/loglevel 这几个标准键
// 实测确认: Shadowrocket 原生支持 gost-plugin, 不需要别名到 v2ray-plugin (而且 v2ray-plugin 在 gost
// 服务端面前根本握不上)。保留原始 plugin 名透传。
const SS_PLUGIN_KEY_WHITELIST = new Set(['mode', 'host', 'path', 'tls', 'mux', 'loglevel']);
function ssPluginUriParam(pluginName, pluginOpts) {
    if (!pluginName) return '';
    const opts = parsePluginOpts(pluginOpts);
    const parts = [pluginName];
    for (const [k, v] of Object.entries(opts)) {
        if (!SS_PLUGIN_KEY_WHITELIST.has(k)) continue;
        if (v === 'true') parts.push(k);
        else if (v === 'false') { if (k === 'mux') parts.push('mux=0'); }
        else parts.push(k + '=' + v);
    }
    return parts.join(';');
}

export function nodeToShareLink(n) {
    if (!n || !n.type) return null;
    const name = encodeFragment(n.name || '');
    try {
        if (n.type === 'vmess') {
            const obj = {
                v: '2',
                ps: n.name || '',
                add: n.server,
                port: String(n.port),
                id: n.uuid || n.user || '',
                aid: String(n.alterId || 0),
                scy: n.cipher || 'auto',
                net: n.network || 'tcp',
                type: 'none',
                host: n.host || '',
                path: n.path || '',
                tls: n.tls ? 'tls' : '',
                sni: n.sni || '',
                fp: n.clientFingerprint || '',
            };
            return 'vmess://' + b64encode(JSON.stringify(obj));
        }
        if (n.type === 'vless') {
            const params = new URLSearchParams();
            if (n.encryption) params.set('encryption', n.encryption);
            // 有 security 字段时透传原值(tls/reality/none),避免纯 TLS+flow 节点被误写成 reality;
            // 老节点没有该字段时再按 tls+flow 推断
            const security = n.security || (n.tls ? (n.flow ? 'reality' : 'tls') : '');
            if (security) params.set('security', security);
            if (n.sni) params.set('sni', n.sni);
            params.set('type', n.network || 'tcp');
            if (n.host) params.set('host', n.host);
            if (n.path) params.set('path', n.path);
            if (n.flow) params.set('flow', n.flow);
            if (n.pbk) params.set('pbk', n.pbk);
            if (n.sid) params.set('sid', n.sid);
            if (n.clientFingerprint) params.set('fp', n.clientFingerprint);
            return `vless://${encodeURIComponent(n.uuid || n.user || '')}@${n.server}:${n.port}?${params.toString()}#${name}`;
        }
        if (n.type === 'ss') {
            const method = n.cipher || 'aes-256-gcm';
            // SIP022: SS-2022 节点 userinfo 不能 base64, 必须 method:percent-encoded-password 明文,
            // 否则 Shadowrocket / v2rayN(sing-box core) 识别不了, 客户端表现为节点延迟 -1。
            // 经典 stream/AEAD 仍然用 URL-safe base64(SIP002 推荐)。
            const isSip022 = /^2022-blake3-/.test(method);
            const userInfo = isSip022
                ? `${method}:${encodeURIComponent(n.pass || '')}`
                : b64encodeUrlSafe(`${method}:${n.pass || ''}`);
            // SIP002: ss plugin 参数直接跟在 host:port 后, 不加 "/"。
            // 实测部分客户端(用户反馈)带 "/" 反而无法解析 plugin、测延迟/连接失败; 不带 "/" 两种解析器都认。
            let suffix = '';
            if (n.plugin) {
                const pParam = ssPluginUriParam(n.plugin, n.pluginOpts);
                if (pParam) suffix = '?plugin=' + encodeURIComponent(pParam);
            }
            return `ss://${userInfo}@${n.server}:${n.port}${suffix}#${name}`;
        }
        if (n.type === 'trojan') {
            const params = new URLSearchParams();
            if (n.sni) params.set('sni', n.sni);
            if (n.network) params.set('type', n.network);
            if (n.network === 'ws') {
                if (n.host) params.set('host', n.host);
                if (n.path) params.set('path', n.path);
            }
            return `trojan://${encodeURIComponent(n.pass || '')}@${n.server}:${n.port}?${params.toString()}#${name}`;
        }
        if (n.type === 'hysteria2' || n.type === 'hy2') {
            const params = new URLSearchParams();
            if (n.sni) params.set('sni', n.sni);
            if (n.pinSHA256) params.set('pinSHA256', n.pinSHA256);
            if (n.skipCertVerify) {
                params.set('insecure', '1');
                // 兼容性: Shadowrocket 等客户端可能用 allowInsecure
                params.set('allowInsecure', '1');
            } else if (n.insecureExplicit) {
                params.set('insecure', '0');
                params.set('allowInsecure', '0');
            }
            const qs = params.toString();
            return `hysteria2://${encodeURIComponent(n.pass || '')}@${n.server}:${n.port}${qs ? '?' + qs : ''}#${name}`;
        }
        if (n.type === 'tuic') {
            const params = new URLSearchParams();
            if (n.sni) params.set('sni', n.sni);
            params.set('alpn', n.alpn || 'h3');
            if (n.congestionControl) params.set('congestion_control', n.congestionControl);
            if (n.skipCertVerify) { params.set('insecure', '1'); params.set('allowInsecure', '1'); }
            const credential = encodeURIComponent((n.uuid || '') + ':' + (n.pass || ''));
            return `tuic://${credential}@${n.server}:${n.port}?${params.toString()}#${name}`;
        }
        if (n.type === 'anytls') {
            // 标准 URI: anytls://<percent-encoded-pass>@host:port/?sni=&insecure=0|1#name
            // 见 anytls-go/docs/uri_scheme.md, Shadowrocket 2.2.65+ / mihomo / sing-box 原生支持。
            const params = new URLSearchParams();
            if (n.sni) params.set('sni', n.sni);
            if (n.skipCertVerify) params.set('insecure', '1');
            const qs = params.toString();
            const suffix = qs ? '/?' + qs : '';
            console.info('[share-export] anytls link name=' + (n.name || '') + ' insecure=' + (n.skipCertVerify ? 1 : 0));
            return `anytls://${encodeURIComponent(n.pass || '')}@${n.server}:${n.port}${suffix}#${name}`;
        }
        if (n.type === 'socks' || n.type === 'socks5') {
            if (n.user) {
                const userInfo = b64encode(`${n.user}:${n.pass || ''}`);
                return `socks://${userInfo}@${n.server}:${n.port}#${name}`;
            }
            return `socks://${n.server}:${n.port}#${name}`;
        }
    } catch (e) {
        console.warn('[share-export] serialize fail for node ' + (n && n.name), e);
        return null;
    }
    return null;
}

// 把工作区里的物理节点(跳过 ⛓️ 衍生)按"全部聚合" + "按组"产出 v2ray 分享链接列表
// returns: { all: [...], groups: [{ id, name, lines: [...] }] }
export function buildShareLinks(workspace) {
    const nodes = Array.isArray(workspace && workspace.nodes) ? workspace.nodes : [];
    const allGroups = Array.isArray(workspace && workspace.groups) ? workspace.groups : [];
    // 未分组暂存区(g-default / 默认分组)不生成分组订阅
    const groups = allGroups.filter(g => !(g && (g.id === 'g-default' || g.name === '默认分组')));

    // 跳过 ⛓️ 前缀的虚拟链路衍生节点(它们只用于 clash 编排,不直接分享)
    const physicalNodes = nodes.filter(n => !(n && typeof n.name === 'string' && n.name.startsWith('⛓️')));

    const all = physicalNodes.map(nodeToShareLink).filter(Boolean);

    const groupOutputs = groups.map(g => {
        const ids = new Set(Array.isArray(g.nodes) ? g.nodes : []);
        const lines = physicalNodes
            .filter(n => ids.has(n.id))
            .map(nodeToShareLink)
            .filter(Boolean);
        return { id: g.id, name: g.name, role: g.role, lines };
    }).filter(g => g.lines.length > 0);

    return { all, groups: groupOutputs };
}

// 把链接数组 join 成 base64(很多客户端订阅协议要求)
export function toBase64Sub(lines) {
    return b64encode(lines.join('\n'));
}

// 服务端 Clash YAML 生成 (compiledYaml 缓存为空时的降级方案)
// 与前端 compileConfig() 对齐: 读取 cfg.groups / cfg.busNames, 生成完整编排
// (总控/入口/落地/矩阵 系统组 + 用户分组 + auto 子组), 保证订阅不再退化为 Auto/Proxy。
function yamlEscape(s) {
    if (s == null) return '';
    const str = String(s);
    if (/[:{}\[\],&*?|>!%@`#'"\n\r]/.test(str) || str === '') return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return str;
}

function yq(s) {
    return `"${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// 单个物理节点 -> clash proxy YAML (对齐前端 writeProxyYamlHelper)
function writeServerProxy(n, pName, dialerProxyGroup) {
    let pYaml = '';
    const name = yq(pName);
    if (n.type === 'socks' || n.type === 'socks5') {
        pYaml += `  - name: ${name}\n    type: socks5\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        if (n.user) pYaml += `    username: ${yq(n.user)}\n`;
        if (n.pass) pYaml += `    password: ${yq(n.pass)}\n`;
    } else if (n.type === 'vmess') {
        pYaml += `  - name: ${name}\n    type: vmess\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        pYaml += `    uuid: ${n.uuid || n.user || ''}\n    alterId: ${n.alterId || 0}\n    cipher: ${yamlEscape(n.cipher || 'auto')}\n`;
        pYaml += `    tls: ${!!n.tls}\n`;
        if (n.sni) pYaml += `    servername: ${yq(n.sni)}\n`;
        if (n.clientFingerprint) pYaml += `    client-fingerprint: ${yq(n.clientFingerprint)}\n`;
        pYaml += `    network: ${yamlEscape(n.network || 'tcp')}\n`;
        if (n.network === 'ws') {
            pYaml += `    ws-opts:\n      path: ${yq(n.path || '/')}\n`;
            if (n.host || n.sni) pYaml += `      headers:\n        Host: ${yq(n.host || n.sni)}\n`;
        }
    } else if (n.type === 'vless') {
        pYaml += `  - name: ${name}\n    type: vless\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        pYaml += `    uuid: ${n.uuid || n.user || ''}\n    cipher: none\n    tls: ${!!n.tls}\n`;
        if (n.flow) pYaml += `    flow: ${yq(n.flow)}\n`;
        if (n.encryption && n.encryption !== 'none') pYaml += `    encryption: ${yq(n.encryption)}\n`;
        if (n.sni) pYaml += `    servername: ${yq(n.sni)}\n`;
        if (n.clientFingerprint) pYaml += `    client-fingerprint: ${yq(n.clientFingerprint)}\n`;
        pYaml += `    network: ${yamlEscape(n.network || 'tcp')}\n`;
        if (n.pbk) {
            pYaml += `    reality-opts:\n      public-key: ${yq(n.pbk)}\n`;
            if (n.sid) pYaml += `      short-id: ${yq(n.sid)}\n`;
        }
        if (n.network === 'ws') {
            pYaml += `    ws-opts:\n      path: ${yq(n.path || '/')}\n`;
            if (n.host || n.sni) pYaml += `      headers:\n        Host: ${yq(n.host || n.sni)}\n`;
        }
    } else if (n.type === 'ss' || n.type === 'shadowsocks') {
        const cipher = (n.cipher || 'aes-256-gcm').toLowerCase();
        if (['ss','vmess','vless','trojan','ssr','tuic','hysteria2'].includes(cipher)) return pYaml;
        pYaml += `  - name: ${name}\n    type: ss\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        pYaml += `    cipher: ${yamlEscape(n.cipher || 'aes-256-gcm')}\n    password: ${yq(n.pass || '')}\n`;
        if (n.plugin) {
            pYaml += `    plugin: ${yamlEscape(n.plugin)}\n`;
            if (n.pluginOpts) pYaml += `    plugin-opts: ${yamlEscape(n.pluginOpts)}\n`;
        }
    } else if (n.type === 'trojan') {
        pYaml += `  - name: ${name}\n    type: trojan\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        pYaml += `    password: ${yq(n.pass || '')}\n`;
        if (n.sni) pYaml += `    sni: ${yq(n.sni)}\n`;
        if (n.clientFingerprint) pYaml += `    client-fingerprint: ${yq(n.clientFingerprint)}\n`;
        pYaml += `    network: ${yamlEscape(n.network || 'tcp')}\n`;
        if (n.network === 'ws') {
            pYaml += `    ws-opts:\n      path: ${yq(n.path || '/')}\n`;
            if (n.host || n.sni) pYaml += `      headers:\n        Host: ${yq(n.host || n.sni)}\n`;
        }
    } else if (n.type === 'hysteria2' || n.type === 'hy2') {
        pYaml += `  - name: ${name}\n    type: hysteria2\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        pYaml += `    password: ${yq(n.pass || '')}\n`;
        pYaml += `    alpn: [${yamlEscape(n.alpn || 'h3')}]\n`;
        if (n.sni) pYaml += `    sni: ${yq(n.sni)}\n`;
        if (n.pinSHA256) pYaml += `    fingerprint: ${yq(n.pinSHA256)}\n`;
        pYaml += `    skip-cert-verify: ${!!n.skipCertVerify}\n`;
    } else if (n.type === 'tuic') {
        pYaml += `  - name: ${name}\n    type: tuic\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        pYaml += `    uuid: ${yamlEscape(n.uuid || '')}\n    password: ${yq(n.pass || '')}\n`;
        pYaml += `    alpn: [${yamlEscape(n.alpn || 'h3')}]\n`;
        if (n.sni) pYaml += `    sni: ${yq(n.sni)}\n`;
        if (n.congestionControl) pYaml += `    congestion-controller: ${yamlEscape(n.congestionControl)}\n`;
        pYaml += `    skip-cert-verify: ${!!n.skipCertVerify}\n`;
    } else if (n.type === 'anytls') {
        pYaml += `  - name: ${name}\n    type: anytls\n    server: ${yamlEscape(n.server)}\n    port: ${n.port}\n`;
        pYaml += `    password: ${yq(n.pass || '')}\n`;
        if (n.sni) pYaml += `    sni: ${yq(n.sni)}\n`;
        if (n.clientFingerprint) pYaml += `    client-fingerprint: ${yq(n.clientFingerprint)}\n`;
        if (n.udp) pYaml += `    udp: true\n`;
        if (n.skipCertVerify) pYaml += `    skip-cert-verify: true\n`;
    } else {
        return pYaml;
    }
    if (dialerProxyGroup) {
        pYaml += `    dialer-proxy: ${yq(dialerProxyGroup)}\n`;
    }
    return pYaml;
}

export function compileClashYaml(cfg) {
    const nodes = Array.isArray(cfg && cfg.nodes) ? cfg.nodes.filter(n => !(n && typeof n.name === 'string' && n.name.startsWith('⛓️'))) : [];
    if (nodes.length === 0) return '';

    // 与前端一致: 暂存区分组不参与编排
    const groups = Array.isArray(cfg && cfg.groups) ? cfg.groups.filter(g => !(g && (g.id === 'g-default' || g.name === '默认分组'))) : [];

    // 系统组名字 (默认值对齐前端)
    const MASTER_NAME = (cfg && cfg.busNames && cfg.busNames.master) || '🚀 核心主控选路';
    const ENTRY_BUS_NAME = (cfg && cfg.busNames && cfg.busNames.entry) || '🛠️ 级联入口总线 (ENTRY)';
    const EXIT_BUS_NAME = (cfg && cfg.busNames && cfg.busNames.exit) || '🛠️ 级联落地总线 (EXIT)';
    const MATRIX_NAME = (cfg && cfg.busNames && cfg.busNames.matrix) || '🔗 动态组合链路 (MATRIX)';

    // 1. 物理节点唯一名映射 (同名加 (1)(2) 后缀, 对齐前端)
    const uniqueNamesMap = {};
    const usedNames = new Set();
    nodes.forEach(n => {
        let baseName = (n.name || 'Node').trim();
        let uniqueName = baseName;
        let counter = 1;
        while (usedNames.has(uniqueName)) {
            uniqueName = `${baseName} (${counter})`;
            counter++;
        }
        usedNames.add(uniqueName);
        uniqueNamesMap[n.id] = uniqueName;
    });

    // 2. 用户分组 clash 名 (不与节点重名)
    const groupClashNameMap = {};
    const usedGroupNames = new Set(usedNames);
    groups.forEach(g => {
        let base = (g.name || 'Group').trim();
        let unique = base;
        let counter = 1;
        while (usedGroupNames.has(unique)) {
            unique = `${base} (${counter})`;
            counter++;
        }
        usedGroupNames.add(unique);
        groupClashNameMap[g.id] = unique;
    });

    // 3.1 relay 虚拟节点: ⛓️ <relayName> | <nodeName> + dialer-proxy -> entry 组
    const relayVirtualNamesMap = {};
    const relayVirtualProxiesYaml = [];
    groups.forEach(g => {
        if (g.role !== 'relay') return;
        const entryG = groups.find(x => x.id === g.entryGroupId);
        const exitG = groups.find(x => x.id === g.exitGroupId);
        if (!entryG || !exitG) return;
        const dialer = groupClashNameMap[entryG.id];
        const list = [];
        (exitG.nodes || []).forEach(nid => {
            const n = nodes.find(x => x.id === nid);
            if (!n) return;
            const vName = `⛓️ ${g.name} | ${uniqueNamesMap[nid]}`;
            list.push(vName);
            relayVirtualProxiesYaml.push(writeServerProxy(n, vName, dialer));
        });
        relayVirtualNamesMap[g.id] = list;
    });

    // 3.2 exit 链式虚拟节点: dialer-proxy -> ENTRY 总线
    const exitChainNamesMap = {};
    const exitChainProxiesYaml = [];
    groups.forEach(g => {
        if (g.role !== 'exit') return;
        const list = [];
        (g.nodes || []).forEach(nid => {
            const n = nodes.find(x => x.id === nid);
            if (!n) return;
            const vName = `⛓️ ${g.name} | ${uniqueNamesMap[nid]}`;
            list.push(vName);
            exitChainProxiesYaml.push(writeServerProxy(n, vName, ENTRY_BUS_NAME));
        });
        exitChainNamesMap[g.id] = list;
    });

    // 4. 组装
    let yaml = '# Calpher Sub - Clash 配置 (服务端自动生成)\n';
    yaml += '# 系统组带 # meta-system: 标识, 导入时自动跳过\n';
    yaml += '# 用户分组带 # meta-clash-id / meta-role 等, 导入后 1:1 还原\n\n';
    yaml += 'port: 7890\nsocks-port: 7891\nallow-lan: false\nmode: rule\nlog-level: info\nipv6: false\n\n';

    yaml += 'proxies:\n';
    nodes.forEach(n => {
        const pName = uniqueNamesMap[n.id];
        if (!pName) return;
        yaml += writeServerProxy(n, pName);
    });
    if (relayVirtualProxiesYaml.length > 0) {
        yaml += `\n# --- relay 虚拟节点 (dialer-proxy -> 固定前置组) ---\n`;
        relayVirtualProxiesYaml.forEach(s => { yaml += s; });
    }
    if (exitChainProxiesYaml.length > 0) {
        yaml += `\n# --- exit 链式虚拟节点 (dialer-proxy -> 动态入口总线) ---\n`;
        exitChainProxiesYaml.forEach(s => { yaml += s; });
    }

    yaml += `\nproxy-groups:\n`;

    // 2.0 系统组
    const exitGroupsArr = groups.filter(g => g.role === 'exit');
    const entryGroups = groups.filter(g => g.role === 'entry');
    const hasSpecialGroups = groups.some(g => g.role !== 'common');
    const commonGroups = groups.filter(g => g.role === 'common');

    if (hasSpecialGroups || commonGroups.length > 0) {
        yaml += `  # meta-system: master\n`;
        yaml += `  - name: ${yq(MASTER_NAME)}\n    type: select\n    proxies:\n`;
        if (exitGroupsArr.length > 0) {
            yaml += `      - ${yq(MATRIX_NAME)}\n`;
        }
        groups.forEach(g => {
            if (g.role === 'exit') return;
            yaml += `      - ${yq(groupClashNameMap[g.id])}\n`;
        });
        yaml += `      - "DIRECT"\n\n`;
    }

    if (entryGroups.length > 0 || exitGroupsArr.length > 0) {
        yaml += `  # meta-system: entry-bus\n`;
        yaml += `  - name: ${yq(ENTRY_BUS_NAME)}\n    type: select\n    proxies:\n`;
        entryGroups.forEach(g => yaml += `      - ${yq(groupClashNameMap[g.id])}\n`);
        yaml += `      - "DIRECT"\n\n`;
    }

    if (exitGroupsArr.length > 0) {
        yaml += `  # meta-system: exit-bus\n`;
        yaml += `  - name: ${yq(EXIT_BUS_NAME)}\n    type: select\n    proxies:\n`;
        exitGroupsArr.forEach(g => yaml += `      - ${yq(groupClashNameMap[g.id])}\n`);
        yaml += `      - "DIRECT"\n\n`;

        yaml += `  # meta-system: matrix\n`;
        yaml += `  - name: ${yq(MATRIX_NAME)}\n    type: select\n    hidden: true\n    proxies:\n`;
        yaml += `      - ${yq(EXIT_BUS_NAME)}\n\n`;
    }

    // 2.1 用户分组
    groups.forEach(g => {
        const cname = groupClashNameMap[g.id];
        if (!cname) return;

        let mainMeta = '';
        mainMeta += `  # meta-clash-id: ${g.id}\n`;
        mainMeta += `  # meta-role: ${g.role || 'common'}\n`;
        if (g.hideAutoSelect) mainMeta += `  # meta-hide-auto: true\n`;
        if (g.allowIndividual) mainMeta += `  # meta-individual: true\n`;
        if (g.entryGroupId) mainMeta += `  # meta-entry-id: ${g.entryGroupId}\n`;
        if (g.exitGroupId) mainMeta += `  # meta-exit-id: ${g.exitGroupId}\n`;

        if (g.role === 'relay') {
            const vNames = relayVirtualNamesMap[g.id] || [];
            yaml += mainMeta;
            yaml += `  - name: ${yq(cname)}\n    type: select\n    proxies:\n`;
            if (vNames.length === 0) {
                yaml += `      - "DIRECT"\n`;
            } else {
                vNames.forEach(v => yaml += `      - ${yq(v)}\n`);
            }
        } else if (g.role === 'exit') {
            const chainNames = exitChainNamesMap[g.id] || [];
            if (chainNames.length === 0) chainNames.push('DIRECT');
            if (chainNames[0] !== 'DIRECT') {
                const chainAutoCname = `⚡auto-${cname}`;
                yaml += `  # meta-chained-auto-of: ${g.id}\n`;
                yaml += `  - name: ${yq(chainAutoCname)}\n    type: url-test\n    url: "http://www.gstatic.com/generate_204"\n    interval: 300\n    tolerance: 50\n    hidden: true\n    proxies:\n`;
                chainNames.forEach(m => yaml += `      - ${yq(m)}\n`);
                yaml += `\n`;
                yaml += mainMeta;
                yaml += `  - name: ${yq(cname)}\n    type: select\n    proxies:\n`;
                yaml += `      - ${yq(chainAutoCname)}\n`;
                chainNames.forEach(m => yaml += `      - ${yq(m)}\n`);
            } else {
                yaml += mainMeta;
                yaml += `  - name: ${yq(cname)}\n    type: select\n    proxies:\n      - "DIRECT"\n`;
            }
        } else {
            const memberNames = (g.nodes || []).map(nid => uniqueNamesMap[nid]).filter(Boolean);
            if (memberNames.length === 0) memberNames.push('DIRECT');
            const wantsAuto = (g.role === 'entry' || g.role === 'common') && memberNames[0] !== 'DIRECT';
            if (wantsAuto) {
                const autoName = `⚡auto-${cname}`;
                yaml += `  # meta-auto-of: ${g.id}\n`;
                yaml += `  - name: ${yq(autoName)}\n    type: url-test\n    url: "http://www.gstatic.com/generate_204"\n    interval: 300\n    tolerance: 50\n    hidden: true\n    proxies:\n`;
                memberNames.forEach(m => yaml += `      - ${yq(m)}\n`);
                yaml += `\n`;
                yaml += mainMeta;
                yaml += `  - name: ${yq(cname)}\n    type: select\n    proxies:\n`;
                yaml += `      - ${yq(autoName)}\n`;
                memberNames.forEach(m => yaml += `      - ${yq(m)}\n`);
            } else {
                yaml += mainMeta;
                yaml += `  - name: ${yq(cname)}\n    type: select\n    proxies:\n`;
                memberNames.forEach(m => yaml += `      - ${yq(m)}\n`);
            }
        }
        yaml += `\n`;
    });

    // 3. 路由规则
    yaml += `rules:\n`;
    yaml += `  - GEOSITE,cn,DIRECT\n  - GEOIP,cn,DIRECT\n`;
    if (hasSpecialGroups || commonGroups.length > 0) {
        yaml += `  - MATCH,${MASTER_NAME}\n`;
    } else {
        yaml += `  - MATCH,DIRECT\n`;
    }
    return yaml;
}
