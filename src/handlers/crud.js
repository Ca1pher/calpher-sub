// 节点 / 分组 维度的细粒度 CRUD API。
// 与 /api/v1/config 共用同一份 KV 存储, 这里在加载完整 config 后做局部修改, 再整体写回。
// 业务标识: 所有日志带 uuid + nodeId/groupId, 不打印密码/UUID 之类敏感凭证。
import { getUser, putUser, getConfig, putConfig, setSubToken } from '../lib/kv.js';
import { randomToken } from '../lib/uuid.js';
import { dedupConfigAgainstExisting, nodeFingerprint } from '../lib/dedup.js';
import { buildSubscriptionView, resolveTargetUuid } from './config.js';
import { json, badRequest, forbidden, notFound } from './_resp.js';

// ============== 工具函数 ==============

function ensureCfg(cfg) {
    if (!cfg) return { nodes: [], groups: [], busNames: {} };
    return {
        nodes: Array.isArray(cfg.nodes) ? cfg.nodes : [],
        groups: Array.isArray(cfg.groups) ? cfg.groups : [],
        busNames: cfg.busNames && typeof cfg.busNames === 'object' ? cfg.busNames : {},
        compiledYaml: typeof cfg.compiledYaml === 'string' ? cfg.compiledYaml : undefined,
    };
}

// 把对外输入的节点字段做基本归一: type/server/port/name 必填, 其余按类型放行
function normalizeNodeInput(input, fallbackId) {
    if (!input || typeof input !== 'object') return { err: 'node 字段缺失' };
    const type = String(input.type || '').toLowerCase();
    const allowed = ['vmess', 'vless', 'ss', 'shadowsocks', 'trojan', 'hysteria2', 'hy2', 'socks', 'socks5'];
    if (!allowed.includes(type)) return { err: '不支持的节点协议: ' + (input.type || '空') };
    const name = String(input.name || '').trim();
    const server = String(input.server || '').trim();
    const port = parseInt(input.port);
    if (!name) return { err: 'name 必填' };
    if (!server) return { err: 'server 必填' };
    if (!port || port < 1 || port > 65535) return { err: 'port 不合法' };
    // 兼容字段全部透传, 不强制限制 (后续编译时再校验)
    const node = { ...input, id: input.id || fallbackId, name, type, server, port };
    return { node };
}

// 写回 config: 跑 dedup, 处理 compiledYaml (若调用者未传, 沿用旧的), 自动签 subToken
async function persistConfig(env, uuid, user, rawSanitized, oldConfig) {
    const deduped = dedupConfigAgainstExisting(rawSanitized, oldConfig, uuid);
    const sanitized = {
        nodes: deduped.nodes,
        groups: deduped.groups,
        busNames: rawSanitized.busNames,
        compiledYaml: rawSanitized.compiledYaml,
        updatedAt: Date.now(),
    };
    if (sanitized.compiledYaml === undefined) {
        if (oldConfig && oldConfig.compiledYaml) sanitized.compiledYaml = oldConfig.compiledYaml;
    }
    // 节点非空 -> 确保用户有 subToken
    let updatedUser = user;
    if (sanitized.nodes.length > 0 && !user.subToken) {
        const tk = randomToken(16);
        await setSubToken(env.CALPHER_KV, tk, uuid);
        updatedUser = { ...user, subToken: tk };
        await putUser(env.CALPHER_KV, updatedUser);
        console.info('[crud] subToken issued uuid=' + uuid + ' token=' + tk.slice(0, 8) + '...');
    }
    await putConfig(env.CALPHER_KV, uuid, sanitized);
    return { sanitized, updatedUser };
}

// 加载目标用户的 config (含权限校验)
async function loadTarget(ctx) {
    const { authCtx, env, request } = ctx;
    const { uuid, err } = resolveTargetUuid(request, authCtx.user);
    if (err) return { err };
    const user = await getUser(env.CALPHER_KV, uuid);
    if (!user) return { err: notFound('用户不存在') };
    const cfg = ensureCfg(await getConfig(env.CALPHER_KV, uuid));
    return { uuid, user, cfg };
}

// ============== 节点 CRUD ==============

export async function handleListNodes(ctx) {
    const r = await loadTarget(ctx); if (r.err) return r.err;
    console.info('[crud] node-list uuid=' + r.uuid + ' count=' + r.cfg.nodes.length);
    return json({ uuid: r.uuid, nodes: r.cfg.nodes });
}

export async function handleGetNode(ctx, nodeId) {
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const node = r.cfg.nodes.find(n => n.id === nodeId);
    if (!node) return notFound('节点不存在: ' + nodeId);
    return json({ uuid: r.uuid, node });
}

export async function handleCreateNode(ctx) {
    const { env, body, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const fallbackId = 'n-api-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const { node, err } = normalizeNodeInput(body, fallbackId);
    if (err) return badRequest(err);

    // 允许 body.groupIds 指定要塞入的分组
    const groupIds = Array.isArray(body && body.groupIds) ? body.groupIds.filter(x => typeof x === 'string') : [];
    const newNodes = [...r.cfg.nodes, node];
    const newGroups = r.cfg.groups.map(g => {
        if (groupIds.includes(g.id)) {
            const arr = Array.isArray(g.nodes) ? [...g.nodes] : [];
            if (!arr.includes(node.id)) arr.push(node.id);
            return { ...g, nodes: arr };
        }
        return g;
    });

    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: newNodes, groups: newGroups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    // 去重后 incoming.id 可能被映射成已有节点的 id, 按指纹找回最终节点
    const fp = nodeFingerprint(node);
    const finalNode = (fp && sanitized.nodes.find(n => nodeFingerprint(n) === fp))
        || sanitized.nodes.find(n => n.id === node.id)
        || sanitized.nodes[sanitized.nodes.length - 1];
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] node-create uuid=' + r.uuid + ' nodeId=' + finalNode.id + ' type=' + finalNode.type);
    return json({ uuid: r.uuid, node: finalNode, subscription: sub }, 201);
}

export async function handleUpdateNode(ctx, nodeId) {
    const { env, body, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const idx = r.cfg.nodes.findIndex(n => n.id === nodeId);
    if (idx === -1) return notFound('节点不存在: ' + nodeId);
    // 合并字段后再归一
    const merged = { ...r.cfg.nodes[idx], ...(body || {}), id: nodeId };
    const { node, err } = normalizeNodeInput(merged, nodeId);
    if (err) return badRequest(err);

    const newNodes = [...r.cfg.nodes];
    newNodes[idx] = node;
    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: newNodes, groups: r.cfg.groups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    const fp = nodeFingerprint(node);
    const finalNode = sanitized.nodes.find(n => n.id === nodeId)
        || (fp && sanitized.nodes.find(n => nodeFingerprint(n) === fp))
        || node;
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] node-update uuid=' + r.uuid + ' nodeId=' + nodeId);
    return json({ uuid: r.uuid, node: finalNode, subscription: sub });
}

export async function handleDeleteNode(ctx, nodeId) {
    const { env, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const exists = r.cfg.nodes.some(n => n.id === nodeId);
    if (!exists) return notFound('节点不存在: ' + nodeId);
    const newNodes = r.cfg.nodes.filter(n => n.id !== nodeId);
    const newGroups = r.cfg.groups.map(g => ({
        ...g,
        nodes: Array.isArray(g.nodes) ? g.nodes.filter(id => id !== nodeId) : [],
    }));
    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: newNodes, groups: newGroups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] node-delete uuid=' + r.uuid + ' nodeId=' + nodeId);
    return json({ uuid: r.uuid, deleted: nodeId, subscription: sub });
}

// ============== 分组 CRUD ==============

function normalizeGroupInput(input, fallbackId) {
    if (!input || typeof input !== 'object') return { err: 'group 字段缺失' };
    const name = String(input.name || '').trim();
    if (!name) return { err: 'name 必填' };
    const role = ['entry', 'common', 'exit', 'relay'].includes(input.role) ? input.role : 'common';
    const nodes = Array.isArray(input.nodes) ? input.nodes.filter(x => typeof x === 'string') : [];
    const group = {
        ...input,
        id: input.id || fallbackId,
        name,
        role,
        nodes: role === 'relay' ? [] : nodes,
        allowIndividual: role === 'entry' ? !!input.allowIndividual : false,
        hideAutoSelect: !!input.hideAutoSelect,
        entryGroupId: role === 'relay' ? String(input.entryGroupId || '') : '',
        exitGroupId: role === 'relay' ? String(input.exitGroupId || '') : '',
    };
    return { group };
}

export async function handleListGroups(ctx) {
    const r = await loadTarget(ctx); if (r.err) return r.err;
    console.info('[crud] group-list uuid=' + r.uuid + ' count=' + r.cfg.groups.length);
    return json({ uuid: r.uuid, groups: r.cfg.groups });
}

export async function handleGetGroup(ctx, groupId) {
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const g = r.cfg.groups.find(x => x.id === groupId);
    if (!g) return notFound('分组不存在: ' + groupId);
    return json({ uuid: r.uuid, group: g });
}

export async function handleCreateGroup(ctx) {
    const { env, body, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const fallbackId = 'g-api-' + Date.now();
    const { group, err } = normalizeGroupInput(body, fallbackId);
    if (err) return badRequest(err);
    if (r.cfg.groups.some(x => x.id === group.id)) return badRequest('分组 id 已存在: ' + group.id);
    // 引用节点必须存在
    const knownNodeIds = new Set(r.cfg.nodes.map(n => n.id));
    group.nodes = group.nodes.filter(id => knownNodeIds.has(id));

    const newGroups = [...r.cfg.groups, group];
    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: r.cfg.nodes, groups: newGroups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] group-create uuid=' + r.uuid + ' groupId=' + group.id + ' role=' + group.role);
    return json({ uuid: r.uuid, group, subscription: sub }, 201);
}

export async function handleUpdateGroup(ctx, groupId) {
    const { env, body, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const idx = r.cfg.groups.findIndex(x => x.id === groupId);
    if (idx === -1) return notFound('分组不存在: ' + groupId);
    const merged = { ...r.cfg.groups[idx], ...(body || {}), id: groupId };
    const { group, err } = normalizeGroupInput(merged, groupId);
    if (err) return badRequest(err);
    // 引用节点必须存在
    const knownNodeIds = new Set(r.cfg.nodes.map(n => n.id));
    group.nodes = group.nodes.filter(id => knownNodeIds.has(id));

    const newGroups = [...r.cfg.groups];
    newGroups[idx] = group;
    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: r.cfg.nodes, groups: newGroups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] group-update uuid=' + r.uuid + ' groupId=' + groupId);
    return json({ uuid: r.uuid, group, subscription: sub });
}

export async function handleDeleteGroup(ctx, groupId) {
    const { env, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const exists = r.cfg.groups.some(x => x.id === groupId);
    if (!exists) return notFound('分组不存在: ' + groupId);
    // 同步: 任何引用此分组的 relay 组也清空其 entryGroupId/exitGroupId
    const newGroups = r.cfg.groups
        .filter(g => g.id !== groupId)
        .map(g => {
            if (g.role !== 'relay') return g;
            const next = { ...g };
            if (next.entryGroupId === groupId) next.entryGroupId = '';
            if (next.exitGroupId === groupId) next.exitGroupId = '';
            return next;
        });
    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: r.cfg.nodes, groups: newGroups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] group-delete uuid=' + r.uuid + ' groupId=' + groupId);
    return json({ uuid: r.uuid, deleted: groupId, subscription: sub });
}

// 分组成员: POST 加节点 / DELETE 移除节点 (一次操作一个)
export async function handleAddGroupNode(ctx, groupId, nodeId) {
    const { env, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const gIdx = r.cfg.groups.findIndex(x => x.id === groupId);
    if (gIdx === -1) return notFound('分组不存在: ' + groupId);
    if (r.cfg.groups[gIdx].role === 'relay') return badRequest('relay 链路组不支持手动添加节点成员');
    const knownNodeIds = new Set(r.cfg.nodes.map(n => n.id));
    if (!knownNodeIds.has(nodeId)) return notFound('节点不存在: ' + nodeId);
    const group = { ...r.cfg.groups[gIdx] };
    group.nodes = Array.isArray(group.nodes) ? [...group.nodes] : [];
    if (group.nodes.includes(nodeId)) {
        return json({ uuid: r.uuid, group, message: '节点已在分组内, 未变化' });
    }
    group.nodes.push(nodeId);
    const newGroups = [...r.cfg.groups];
    newGroups[gIdx] = group;

    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: r.cfg.nodes, groups: newGroups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] group-add-node uuid=' + r.uuid + ' groupId=' + groupId + ' nodeId=' + nodeId);
    return json({ uuid: r.uuid, group, subscription: sub });
}

export async function handleRemoveGroupNode(ctx, groupId, nodeId) {
    const { env, request } = ctx;
    const r = await loadTarget(ctx); if (r.err) return r.err;
    const gIdx = r.cfg.groups.findIndex(x => x.id === groupId);
    if (gIdx === -1) return notFound('分组不存在: ' + groupId);
    const group = { ...r.cfg.groups[gIdx] };
    const before = Array.isArray(group.nodes) ? group.nodes.length : 0;
    group.nodes = Array.isArray(group.nodes) ? group.nodes.filter(id => id !== nodeId) : [];
    if (group.nodes.length === before) {
        return json({ uuid: r.uuid, group, message: '节点不在该分组内, 未变化' });
    }
    const newGroups = [...r.cfg.groups];
    newGroups[gIdx] = group;
    const { sanitized, updatedUser } = await persistConfig(env, r.uuid, r.user, {
        nodes: r.cfg.nodes, groups: newGroups, busNames: r.cfg.busNames, compiledYaml: undefined,
    }, r.cfg);
    const sub = await buildSubscriptionView(env, request, updatedUser, sanitized);
    console.info('[crud] group-remove-node uuid=' + r.uuid + ' groupId=' + groupId + ' nodeId=' + nodeId);
    return json({ uuid: r.uuid, group, subscription: sub });
}
