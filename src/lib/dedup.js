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
        // 同一 CDN IP:port + 同一 uuid 的 ws 节点, 可能靠 host/sni/path 分发到不同后端,
        // 不把这些路由字段纳入指纹会把真正不同的节点误合并 (用户实测 NL-1/USA-3 等被收成一份)。
        // 浏览器端 index.html nodeFingerprint 有同样实现, 修改时两边要同步。
        auth += '|' + (n.network || '').trim().toLowerCase()
            + '|' + (n.sni || '').trim().toLowerCase()
            + '|' + (n.host || '').trim().toLowerCase()
            + '|' + String(n.path || '');
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
    } else if (t === 'trojan') {
        auth = (n.pass || '');
        // 与 vless 同理: ws trojan 的 host/sni/path 决定实际后端, 必须纳入指纹
        auth += '|' + (n.network || '').trim().toLowerCase()
            + '|' + (n.sni || '').trim().toLowerCase()
            + '|' + (n.host || '').trim().toLowerCase()
            + '|' + String(n.path || '');
    } else if (t === 'hysteria2' || t === 'hy2') {
        auth = (n.pass || '') + '|' + (n.sni || '').trim().toLowerCase();
    } else if (t === 'anytls') {
        auth = (n.pass || '') + '|' + (n.sni || '').trim().toLowerCase();
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
    // 旧配置内部可能存在同指纹的多条节点(用户手动保留的重复,或脚本多次推送的别名)。
    // 去重时必须以「旧配置存了多少份」为配额,逐份保留; 只对超出配额的真正新增部分
    // 才做内部合并。否则脚本推送(把完整 config 原样传回)会把旧配置里已有的重复合并掉,
    // 导致用户导入的 35 个节点默默变成 32 个。
    const oldByFp = new Map();
    for (const n of oldNodes) {
        const fp = nodeFingerprint(n);
        if (!fp) continue;
        if (!oldByFp.has(fp)) oldByFp.set(fp, []);
        oldByFp.get(fp).push(n);
    }
    const idMap = {};
    let reused = 0;
    const finalNodes = [];
    // 真正新增节点(超出 old 配额)里同指纹的,统一指向第一个
    const newFirstByFp = new Map();
    for (const inc of incoming.nodes) {
        const fp = nodeFingerprint(inc);
        if (!fp) {
            finalNodes.push(inc);
            continue;
        }
        const pool = oldByFp.get(fp);
        if (pool && pool.length > 0) {
            // 从旧配置配额里取一份:优先命中 id 完全相同的(就地编辑),
            // 否则取剩余配额中的任意一份(贴合原有行为,并保留该份的原名)。
            let idx = pool.findIndex(o => o.id === inc.id);
            let oldNode = null;
            if (idx !== -1) {
                oldNode = pool[idx];
                pool.splice(idx, 1);
            } else {
                oldNode = pool.shift();
            }
            oldByFp.set(fp, pool);
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
            finalNodes.push(merged);
            reused++;
        } else if (newFirstByFp.has(fp)) {
            // 旧配置里没有这一份 + incoming 内部同指纹重复 -> 合并到新增的第一个
            const firstId = newFirstByFp.get(fp);
            idMap[inc.id] = firstId;
        } else {
            // 真正的新增节点
            newFirstByFp.set(fp, inc.id);
            idMap[inc.id] = inc.id;
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
