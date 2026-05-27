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
                id: n.uuid || '',
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
            if (n.tls) params.set('security', 'tls');
            if (n.sni) params.set('sni', n.sni);
            params.set('type', n.network || 'tcp');
            if (n.host) params.set('host', n.host);
            if (n.path) params.set('path', n.path);
            if (n.clientFingerprint) params.set('fp', n.clientFingerprint);
            return `vless://${encodeURIComponent(n.uuid || '')}@${n.server}:${n.port}?${params.toString()}#${name}`;
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
            // SIP002: 带 plugin 时 host:port 后面必须有 "/", 否则 Shadowrocket 等严格客户端无法解析 plugin 参数
            let suffix = '';
            if (n.plugin) {
                const pParam = ssPluginUriParam(n.plugin, n.pluginOpts);
                if (pParam) suffix = '/?plugin=' + encodeURIComponent(pParam);
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
            if (n.skipCertVerify) params.set('insecure', '1');
            return `hysteria2://${encodeURIComponent(n.pass || '')}@${n.server}:${n.port}/?${params.toString()}#${name}`;
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
    const groups = Array.isArray(workspace && workspace.groups) ? workspace.groups : [];

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
