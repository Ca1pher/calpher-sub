// 节点指纹: 按"协议 + 主机 + 端口 + 核心认证字段"判断"完全相同的节点"。
// 浏览器端有一份等价实现(index.html 内 nodeFingerprint),修改时两边要保持一致。
export function nodeFingerprint(n) {
    if (!n || !n.type) return '';
    const t = String(n.type).toLowerCase();
    const host = String(n.server || '').toLowerCase().trim();
    const port = parseInt(n.port) || 0;
    let auth = '';
    if (t === 'vmess' || t === 'vless') {
        auth = (n.uuid || '').trim();
    } else if (t === 'ss' || t === 'shadowsocks') {
        auth = (n.cipher || '') + ':' + (n.pass || '');
        // 机场常用一对 SS 2022 密钥, 靠 plugin-opts 的 host/path 切到不同后端,
        // 不把它们算进 fingerprint 会被误合并(用户实测 18 个真不同节点收成 10 个)。
        // 浏览器端 index.html nodeFingerprint 有同样实现, 修改时两边要同步。
        if (n.plugin) {
            let pluginHost = '', pluginPath = '';
            for (const pair of String(n.pluginOpts || '').split(',')) {
                const ci = pair.indexOf(':');
                if (ci === -1) continue;
                const k = pair.slice(0, ci).trim();
                const v = pair.slice(ci + 1).trim().replace(/^['"]|['"]$/g, '');
                if (k === 'host') pluginHost = v;
                else if (k === 'path') pluginPath = v;
            }
            auth += '|' + n.plugin + '|' + pluginHost + '|' + pluginPath;
        }
    } else if (t === 'trojan' || t === 'hysteria2' || t === 'hy2') {
        auth = (n.pass || '');
    } else if (t === 'anytls') {
        auth = (n.pass || '');
    } else if (t === 'tuic') {
        auth = (n.uuid || '') + ':' + (n.pass || '');
        auth = (n.pass || '');
    } else if (t === 'socks' || t === 'socks5') {
        const u = (n.user || '').trim();
        const p = (n.pass || '').trim();
        // 无认证的 socks 节点: 同一 IP:port 可能是不同优选IP分配,不能合并
        if (!u && !p) return '';
        auth = u + ':' + p;
    } else {
        auth = JSON.stringify(n);
    }
    return `${t}|${host}|${port}|${auth}`;
}

// 给传入的 config (含 nodes/groups) 与已存在的 oldConfig 做去重保留原名:
//   - incoming.nodes 中,指纹与 oldConfig.nodes 某个节点相同的,使用 old 的 id+name
//   - incoming.groups 里引用的 node id 同步替换为映射后的 id
//   - groups 内部对同一 id 出现多次再做一次顺序去重
// 返回新的 config 对象(浅拷贝,不修改入参)。
export function dedupConfigAgainstExisting(incoming, oldConfig, ownerUuid) {
    if (!incoming || !Array.isArray(incoming.nodes)) return incoming;
    const oldNodes = (oldConfig && Array.isArray(oldConfig.nodes)) ? oldConfig.nodes : [];
    const fpToOld = new Map();
    for (const n of oldNodes) {
        const fp = nodeFingerprint(n);
        if (fp) fpToOld.set(fp, n);
    }
    const idMap = {};
    let reused = 0;
    const seenFp = new Set();
    const finalNodes = [];
    for (const inc of incoming.nodes) {
        const fp = nodeFingerprint(inc);
        if (!fp) {
            finalNodes.push(inc);
            continue;
        }
        if (seenFp.has(fp)) {
            // incoming 自己内部也重复了,统一指向第一个
            const firstId = idMap[fp + '::first'];
            if (firstId) idMap[inc.id] = firstId;
            continue;
        }
        seenFp.add(fp);
        if (fpToOld.has(fp)) {
            const oldNode = fpToOld.get(fp);
            // 区分两种命中场景:
            //  A) inc.id === oldNode.id:用户就地编辑同一节点(可能只改了名字/sni/plugin等
            //     不影响指纹的字段)。如果还把 name 覆写回旧值,用户的"改名"就保存失败了。
            //  B) inc.id !== oldNode.id:重新 import 了同指纹节点,旧 id 已经在 groups 中
            //     被引用,需要把 incoming 映射回 old 的 id+name,避免破坏分组引用和原名。
            let merged;
            if (inc.id === oldNode.id) {
                merged = { ...inc };
                console.info('[dedup] in-place edit fp=' + fp.slice(0, 32) + ' uuid=' + (ownerUuid || '?') + ' id=' + inc.id);
            } else {
                merged = { ...inc, id: oldNode.id, name: oldNode.name };
                console.info('[dedup] reuse old fp=' + fp.slice(0, 32) + ' uuid=' + (ownerUuid || '?') + ' incId=' + inc.id + ' -> oldId=' + oldNode.id);
            }
            idMap[inc.id] = oldNode.id;
            idMap[fp + '::first'] = oldNode.id;
            finalNodes.push(merged);
            reused++;
        } else {
            idMap[inc.id] = inc.id;
            idMap[fp + '::first'] = inc.id;
            finalNodes.push(inc);
        }
    }
    const finalGroups = Array.isArray(incoming.groups) ? incoming.groups.map(g => {
        const mappedIds = (g.nodes || []).map(nid => idMap[nid] || nid);
        const seen = new Set();
        const deduped = mappedIds.filter(nid => seen.has(nid) ? false : (seen.add(nid), true));
        return { ...g, nodes: deduped };
    }) : [];
    if (reused > 0) {
        console.info('[config] dedup uuid=' + (ownerUuid || '?') + ' incoming=' + incoming.nodes.length + ' final=' + finalNodes.length + ' reused=' + reused);
    }
    return { ...incoming, nodes: finalNodes, groups: finalGroups };
}
