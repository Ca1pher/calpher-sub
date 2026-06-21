import { getUser, putUser, getConfig, putConfig, setSubToken, deleteSubToken, getSubTokenOwner } from '../lib/kv.js';
import { randomToken } from '../lib/uuid.js';
import { buildShareLinks } from '../lib/subscription.js';
import { dedupConfigAgainstExisting } from '../lib/dedup.js';
import { json, badRequest, forbidden, notFound } from './_resp.js';

// 工具:能否操作 targetUuid 的配置?
function canManage(authUser, targetUuid) {
    if (!authUser) return false;
    if (authUser.role === 'admin') return true;
    return authUser.uuid === targetUuid;
}

function resolveTargetUuid(request, authUser) {
    const url = new URL(request.url);
    const requested = url.searchParams.get('uuid');
    if (requested && requested !== authUser.uuid) {
        if (authUser.role !== 'admin') return { err: forbidden('仅管理员可访问他人配置') };
        return { uuid: requested };
    }
    return { uuid: authUser.uuid };
}

export { resolveTargetUuid };

export async function handleGetConfig(ctx) {
    const { authCtx, env, request } = ctx;
    const { uuid, err } = resolveTargetUuid(request, authCtx.user);
    if (err) return err;
    const targetUser = await getUser(env.CALPHER_KV, uuid);
    if (!targetUser) return notFound('用户不存在');
    const cfg = await getConfig(env.CALPHER_KV, uuid);
    const sub = await buildSubscriptionView(env, request, targetUser, cfg);
    return json({
        uuid,
        config: cfg || { nodes: [], groups: [], busNames: {} },
        subscription: sub,
    });
}

export async function handleSaveConfig(ctx) {
    const { authCtx, env, request, body } = ctx;
    const { uuid, err } = resolveTargetUuid(request, authCtx.user);
    if (err) return err;
    const targetUser = await getUser(env.CALPHER_KV, uuid);
    if (!targetUser) return notFound('用户不存在');
    if (!body || typeof body !== 'object') return badRequest('请求体非法');
    const cfg = body.config || body; // 兼容直接传 { nodes, groups, busNames }
    if (!cfg || typeof cfg !== 'object') return badRequest('config 字段缺失');

    const rawSanitized = {
        nodes: Array.isArray(cfg.nodes) ? cfg.nodes : [],
        groups: Array.isArray(cfg.groups) ? cfg.groups : [],
        busNames: cfg.busNames && typeof cfg.busNames === 'object' ? cfg.busNames : {},
        // 可选: 浏览器编译好的 clash yaml,优先采用;外部 PUT 不传则保留原有
        compiledYaml: typeof cfg.compiledYaml === 'string' ? cfg.compiledYaml : undefined,
    };

    // 与已有配置做指纹去重,完全相同的节点保留原 id+name(浏览器端已做一次,这里再保险一次给外部 API)
    // 浏览器端保存时传 skipDedup:true 跳过(优选IP场景同一 server:port 可能是不同分配)
    const skipDedup = !!body.skipDedup;
    const old = await getConfig(env.CALPHER_KV, uuid);
    const deduped = skipDedup ? rawSanitized : dedupConfigAgainstExisting(rawSanitized, old, uuid);

    const sanitized = {
        nodes: deduped.nodes,
        groups: deduped.groups,
        busNames: rawSanitized.busNames,
        compiledYaml: rawSanitized.compiledYaml,
        updatedAt: Date.now(),
    };
    // compiledYaml 逻辑: 空字符串视为"未传",保留旧值;有内容则更新
    if (!sanitized.compiledYaml && sanitized.compiledYaml !== '0') {
        if (old && old.compiledYaml) sanitized.compiledYaml = old.compiledYaml;
    }

    // 若 nodes 非空 -> 确保用户有 subToken
    let updatedUser = targetUser;
    if (sanitized.nodes.length > 0 && !targetUser.subToken) {
        const tk = randomToken(16);
        await setSubToken(env.CALPHER_KV, tk, uuid);
        updatedUser = { ...targetUser, subToken: tk };
        await putUser(env.CALPHER_KV, updatedUser);
        console.info('[config] subToken issued uuid=' + uuid + ' token=' + tk.slice(0, 8) + '...');
    }
    await putConfig(env.CALPHER_KV, uuid, sanitized);
    console.info('[config] saved uuid=' + uuid + ' nodes=' + sanitized.nodes.length + ' groups=' + sanitized.groups.length + ' by=' + authCtx.user.uuid);

    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    return json({ uuid, config: sanitized, subscription: sub });
}

export async function handleRotateSubToken(ctx) {
    const { authCtx, env, request } = ctx;
    const { uuid, err } = resolveTargetUuid(request, authCtx.user);
    if (err) return err;
    const targetUser = await getUser(env.CALPHER_KV, uuid);
    if (!targetUser) return notFound('用户不存在');
    // 删除旧 token, 生成新的
    if (targetUser.subToken) await deleteSubToken(env.CALPHER_KV, targetUser.subToken);
    const tk = randomToken(16);
    await setSubToken(env.CALPHER_KV, tk, uuid);
    const updated = { ...targetUser, subToken: tk };
    await putUser(env.CALPHER_KV, updated);
    console.info('[config] subToken rotated uuid=' + uuid + ' old=' + (targetUser.subToken || '').slice(0, 8) + '... new=' + tk.slice(0, 8) + '... by=' + authCtx.user.uuid);
    const cfg = await getConfig(env.CALPHER_KV, uuid);
    const sub = await buildSubscriptionView(env, request, updated, cfg);
    return json({ uuid, subscription: sub });
}

// 构建对外 subscription 视图(URL 列表)。无 subToken 或无节点 -> null
export async function buildSubscriptionView(env, request, user, cfg) {
    if (!user || !user.subToken) return null;
    if (!cfg || !Array.isArray(cfg.nodes) || cfg.nodes.length === 0) return null;
    const baseUrl = new URL(request.url).origin;
    const tk = user.subToken;
    const urls = {
        clash: `${baseUrl}/sub/${tk}/clash`,
        v2ray: `${baseUrl}/sub/${tk}/v2ray`,
        groups: [],
    };
    // 列出每个组的小火箭/V2Ray 订阅
    const shareData = buildShareLinks(cfg);
    for (const g of shareData.groups) {
        urls.groups.push({
            id: g.id,
            name: g.name,
            role: g.role,
            url: `${baseUrl}/sub/${tk}/group/${encodeURIComponent(g.id)}`,
        });
    }
    return { subToken: tk, urls };
}

export async function handleListMySubscription(ctx) {
    const { authCtx, env, request } = ctx;
    const user = authCtx.user;
    const cfg = await getConfig(env.CALPHER_KV, user.uuid);
    const sub = await buildSubscriptionView(env, request, user, cfg);
    return json({ uuid: user.uuid, subscription: sub });
}
