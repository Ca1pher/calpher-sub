// 把工作区 nodes/groups 序列化成 v2ray/小火箭可识别的分享链接列表
// 与浏览器端 nodeToShareLink() 保持一致

function b64encode(str) {
    // unescape(encodeURIComponent(...)) -> binary safe before btoa
    return btoa(unescape(encodeURIComponent(str)));
}

export function nodeToShareLink(n) {
    if (!n || !n.type) return null;
    const name = encodeURIComponent(n.name || '');
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
            const userInfo = b64encode(`${n.cipher || 'aes-256-gcm'}:${n.pass || ''}`);
            return `ss://${userInfo}@${n.server}:${n.port}#${name}`;
        }
        if (n.type === 'trojan') {
            const params = new URLSearchParams();
            if (n.sni) params.set('sni', n.sni);
            if (n.network) params.set('type', n.network);
            return `trojan://${encodeURIComponent(n.pass || '')}@${n.server}:${n.port}?${params.toString()}#${name}`;
        }
        if (n.type === 'hysteria2' || n.type === 'hy2') {
            const params = new URLSearchParams();
            if (n.sni) params.set('sni', n.sni);
            if (n.skipCertVerify) params.set('insecure', '1');
            return `hysteria2://${encodeURIComponent(n.pass || '')}@${n.server}:${n.port}/?${params.toString()}#${name}`;
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
