import { getSubTokenOwner, getUser, getConfig } from '../lib/kv.js';
import { buildShareLinks, toBase64Sub, compileClashYaml } from '../lib/subscription.js';
import { notFound, text } from './_resp.js';

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
        let yaml = cfg.compiledYaml || '';
        // 旧缓存可能含 uuid: undefined (非法 YAML), 降级到服务端生成
        if (!yaml || yaml.includes('uuid: undefined')) {
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
