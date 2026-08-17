import { getSubTokenOwner, getUser, getConfig } from '../lib/kv.js';
import { buildShareLinks, toBase64Sub, compileClashYaml, nodesHash } from '../lib/subscription.js';
import { notFound, text } from './_resp.js';

// 统计缓存 YAML 的 physical proxies 段中"物理节点"条数(跳过 ⛓️ 衍生节点与 proxy-groups 段)。
// 若与当前 cfg.nodes 数量不一致,说明这份缓存是基于不同的(更大/更旧)节点集编译的,
// 直接丢弃重算,防止 clash 订阅一直吐残留节点(如重名加 (1) 的旧缓存)。
function physicalProxyCount(yaml) {
    if (!yaml || typeof yaml !== 'string') return 0;
    let count = 0;
    let inProxies = false;
    for (const line of yaml.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'proxies:') { inProxies = true; continue; }
        if (trimmed.startsWith('proxy-groups:')) break;
        if (!inProxies) continue;
        const m = trimmed.match(/^-\s+name:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
        if (!m) continue;
        const name = m[1] ?? m[2] ?? m[3] ?? '';
        if (name.startsWith('⛓️')) continue;
        count++;
    }
    return count;
}

// /sub/<token>/clash | /sub/<token>/v2ray | /sub/<token>/group/<groupId>
// 公开访问 -- 不需要登录
export async function handlePublicSubscription(env, request, path) {
    // path 形如 /sub/<token>/<kind>[/<rest>]
    const parts = path.split('/').filter(Boolean); // ["sub","<token>","clash"]
    if (parts.length < 3) return notFound('subscription path invalid');
    const token = parts[1];
    const kind = parts[2];
    const rest = parts.slice(3);

    const uuid = await getSubTokenOwner(env.CALPHER_KV, token);
    if (!uuid) {
        console.warn('[sub] unknown token=' + token.slice(0, 8) + '...');
        return notFound('订阅 token 不存在或已被重置');
    }
    const user = await getUser(env.CALPHER_KV, uuid);
    if (!user) {
        console.warn('[sub] token owner missing uuid=' + uuid);
        return notFound('订阅对应用户已删除');
    }
    const cfg = await getConfig(env.CALPHER_KV, uuid);
    if (!cfg || !Array.isArray(cfg.nodes) || cfg.nodes.length === 0) {
        return notFound('用户尚未保存任何节点');
    }

    if (kind === 'clash') {
        // 缓存 compiledYaml 只有在"节点数据未变"时才可信(compiledNodesHash 校验),
        // 否则直接按当前节点重算,避免 clash 订阅吐旧凭证、与 v2ray 订阅不一致。
        let yaml = '';
        if (cfg.compiledNodesHash) {
            const nodeHash = await nodesHash(cfg.nodes);
            if (cfg.compiledNodesHash === nodeHash) yaml = cfg.compiledYaml || '';
        } else {
            // 旧数据没有指纹: 沿用原逻辑信任缓存(等用户下一次保存写入新指纹)
            yaml = cfg.compiledYaml || '';
        }
        // 防御性兜底: 缓存里的物理节点条数与当前节点数不一致时,说明缓存基于不同的节点集
        // (例如浏览器在孤儿清理前编译、服务端落库后清掉了孤儿节点),必须重算。
        if (yaml && physicalProxyCount(yaml) !== (cfg.nodes || []).filter(n => !(n && typeof n.name === 'string' && n.name.startsWith('⛓️'))).length) {
            console.info('[sub] cached compiledYaml proxy-count mismatch uuid=' + uuid + ' cached=' + physicalProxyCount(yaml) + ' nodes=' + cfg.nodes.length);
            yaml = '';
        }
        // 旧缓存可能含 uuid: undefined 或 reality-opts 旧格式, 降级到服务端生成
        if (!yaml || yaml.includes('uuid: undefined') || yaml.includes('publicKey:') || yaml.includes('shortId:')) {
            yaml = compileClashYaml(cfg);
            if (!yaml) {
                return text('# 没有可用节点\n', 404, { 'Content-Disposition': 'inline; filename="config.yaml"' });
            }
        }
        console.info('[sub] serve clash uuid=' + uuid + ' bytes=' + yaml.length);
        return new Response(yaml, {
            status: 200,
            headers: {
                'Content-Type': 'text/yaml; charset=utf-8',
                'Content-Disposition': `inline; filename="${encodeURIComponent(user.name || 'calpher')}.yaml"`,
                'Cache-Control': 'no-cache',
            },
        });
    }

    if (kind === 'v2ray') {
        const shareData = buildShareLinks(cfg);
        if (shareData.all.length === 0) return notFound('没有可分享的物理节点');
        const sub = toBase64Sub(shareData.all);
        console.info('[sub] serve v2ray uuid=' + uuid + ' lines=' + shareData.all.length);
        return text(sub, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Profile-Update-Interval': '24',
            'Cache-Control': 'no-cache',
        });
    }

    if (kind === 'group' && rest.length >= 1) {
        const groupId = decodeURIComponent(rest[0]);
        const shareData = buildShareLinks(cfg);
        const g = shareData.groups.find(x => x.id === groupId);
        if (!g) return notFound('分组不存在或无节点');
        const sub = toBase64Sub(g.lines);
        console.info('[sub] serve group uuid=' + uuid + ' group=' + g.name + ' lines=' + g.lines.length);
        return text(sub, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Profile-Update-Interval': '24',
            'Cache-Control': 'no-cache',
        });
    }

    return notFound('subscription kind unsupported');
}
