import { listUsers, getUser, putUser, deleteUser, getConfig, deleteConfig, getSubTokenOwner, deleteSubToken, kvKey } from '../lib/kv.js';
import { isValidUuid } from '../lib/uuid.js';
import { json, badRequest, forbidden } from './_resp.js';

export async function handleListUsers(ctx) {
    const { authCtx, env } = ctx;
    if (authCtx.user.role !== 'admin') return forbidden('仅管理员可查看用户列表');
    const all = await listUsers(env.CALPHER_KV);
    // 加 hasSubscription 标记
    const out = await Promise.all(all.map(async u => {
        const cfg = await getConfig(env.CALPHER_KV, u.uuid);
        return {
            uuid: u.uuid,
            name: u.name,
            role: u.role,
            createdAt: u.createdAt,
            hasSubscription: !!(u.subToken && cfg && Array.isArray(cfg.nodes) && cfg.nodes.length > 0),
        };
    }));
    // 按角色 + 创建时间排序:admin 在前
    out.sort((a, b) => {
        if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
    });
    console.info('[users] list returned count=' + out.length + ' by=' + authCtx.user.uuid);
    return json({ users: out });
}

export async function handleCreateUser(ctx) {
    const { authCtx, env, body } = ctx;
    if (authCtx.user.role !== 'admin') return forbidden('仅管理员可创建用户');
    const name = (body && body.name || '').trim();
    const uuid = (body && body.uuid || '').trim();
    const role = body && body.role === 'admin' ? 'admin' : 'user';
    if (!name) return badRequest('用户名不能为空');
    if (!isValidUuid(uuid)) return badRequest('UUID 格式不正确(必须是 v4)');
    const existing = await getUser(env.CALPHER_KV, uuid);
    if (existing) return badRequest('该 UUID 已经存在');
    const user = { uuid, name, role, createdAt: Date.now() };
    await putUser(env.CALPHER_KV, user);
    console.info('[users] created uuid=' + uuid + ' role=' + role + ' by=' + authCtx.user.uuid);
    return json({ user }, 201);
}

export async function handleDeleteUser(ctx, targetUuid) {
    const { authCtx, env } = ctx;
    if (authCtx.user.role !== 'admin') return forbidden('仅管理员可删除用户');
    if (targetUuid === authCtx.user.uuid) return badRequest('不能删除自己');
    const target = await getUser(env.CALPHER_KV, targetUuid);
    if (!target) return badRequest('用户不存在');
    // 顺带清理 config / subToken
    if (target.subToken) await deleteSubToken(env.CALPHER_KV, target.subToken);
    await deleteConfig(env.CALPHER_KV, targetUuid);
    await deleteUser(env.CALPHER_KV, targetUuid);
    console.info('[users] deleted uuid=' + targetUuid + ' by=' + authCtx.user.uuid);
    return json({ ok: true });
}
