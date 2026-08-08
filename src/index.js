// Calpher 订阅管理 - Cloudflare Worker 入口
import indexHtml from './static/index.html';
import {
    authenticate, loginByUuid, logout, buildSessionCookie, buildLogoutCookie,
    ensureAdminBootstrap,
} from './lib/auth.js';
import { handleListUsers, handleCreateUser, handleDeleteUser } from './handlers/users.js';
import {
    handleGetConfig, handleSaveConfig, handleRotateSubToken, handleListMySubscription,
} from './handlers/config.js';
import {
    handleListNodes, handleGetNode, handleCreateNode, handleUpdateNode, handleDeleteNode,
    handleBatchCreateNodes,
    handleListGroups, handleGetGroup, handleCreateGroup, handleUpdateGroup, handleDeleteGroup,
    handleAddGroupNode, handleRemoveGroupNode,
} from './handlers/crud.js';
import { handlePublicSubscription } from './handlers/sub.js';
import { json, badRequest, unauthorized, notFound } from './handlers/_resp.js';
import {
    buildLogoutCookie as buildFederatedLogoutCookie,
    buildMasterLoginUrl,
    buildSessionCookie as buildFederatedSessionCookie,
    createSession as createFederatedSession,
    getAuthMode,
    verifyHandoffTicket,
} from '../auth/auth.js';

async function readJsonBody(request) {
    const ct = request.headers.get('Content-Type') || '';
    if (!ct.includes('application/json')) return null;
    try { return await request.json(); } catch (e) { return null; }
}

function htmlResponse() {
    return new Response(indexHtml, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
        },
    });
}

async function route(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const federated = getAuthMode(env) === 'federated';

    // 1. 公开订阅(无需登录)
    if (path.startsWith('/sub/')) {
        return await handlePublicSubscription(env, request, path);
    }

    // 2. Calpher 统一鉴权回调(无需登录)
    if (path === '/.calpher/auth/callback' && method === 'GET') {
        if (!federated) return notFound('route not found');
        const verified = await verifyHandoffTicket(env, url.searchParams.get('ticket'), url.origin);
        if (!verified) return unauthorized('登录票据无效或已过期');
        const sid = await createFederatedSession(env, verified.user);
        const callbackTarget = new URL(verified.returnUrl);
        return new Response(null, {
            status: 302,
            headers: {
                'Location': verified.returnUrl,
                'Set-Cookie': buildFederatedSessionCookie(sid, request, env, {
                    partitioned: callbackTarget.searchParams.get('embed') === '1',
                }),
                'Cache-Control': 'no-store',
            },
        });
    }

    // 3. 独立模式登录(无需登录)
    if (path === '/api/auth/login' && method === 'POST') {
        if (federated) {
            return json({
                error: '当前站点使用统一鉴权',
                loginUrl: buildMasterLoginUrl(request, env, `${url.origin}/`),
            }, 409);
        }
        const body = await readJsonBody(request);
        const uuid = body && body.uuid && body.uuid.trim();
        if (!uuid) return badRequest('uuid 必填');
        try {
            const { user, sid } = await loginByUuid(env, uuid);
            return json({ uuid: user.uuid, name: user.name, role: user.role }, 200, {
                'Set-Cookie': buildSessionCookie(sid),
            });
        } catch (e) {
            return json({ error: e.message }, 401);
        }
    }
    if (path === '/api/auth/logout' && method === 'POST') {
        const authCtx = await authenticate(request, env);
        if (authCtx.sid) await logout(env, authCtx.sid);
        return json({ ok: true }, 200, {
            'Set-Cookie': federated
                ? buildFederatedLogoutCookie(request, env)
                : buildLogoutCookie(),
        });
    }
    if (path === '/api/auth/logout' && method === 'GET') {
        if (!federated) return notFound('route not found');
        const partitioned = url.searchParams.get('partitioned') === '1';
        const headers = {
            'Cache-Control': 'no-store',
            'Set-Cookie': buildFederatedLogoutCookie(request, env, { partitioned }),
        };
        if (partitioned) {
            headers['Content-Type'] = 'text/html; charset=utf-8';
            return new Response('<!doctype html><title>Signed out</title>', { headers });
        }
        let masterOrigin = '';
        try { masterOrigin = new URL(env.AUTH_MASTER_ORIGIN).origin; } catch (e) {}
        const returnUrl = url.searchParams.get('return');
        let target = masterOrigin ? new URL('/login', masterOrigin).toString() : '/';
        if (returnUrl) {
            try {
                const candidate = new URL(returnUrl);
                if (candidate.origin !== masterOrigin) return badRequest('logout return 地址无效');
                target = candidate.toString();
            } catch (e) {
                return badRequest('logout return 地址无效');
            }
        }
        headers.Location = target;
        return new Response(null, { status: 302, headers });
    }

    // 4. 需要登录的接口
    const authCtx = await authenticate(request, env);

    // 统一鉴权模式下页面入口直接跳主站；独立模式保留 UUID 登录弹窗。
    if (path === '/' || path === '/index.html') {
        if (federated && !authCtx.user) {
            return Response.redirect(buildMasterLoginUrl(request, env), 302);
        }
        return htmlResponse();
    }

    if (!authCtx.user) {
        if (path.startsWith('/api/')) {
            const payload = { error: '请先登录' };
            if (federated) payload.loginUrl = buildMasterLoginUrl(request, env, `${url.origin}/`);
            return json(payload, 401);
        }
        return htmlResponse();
    }

    // /api/me
    if (path === '/api/me' && method === 'GET') {
        const u = authCtx.user;
        return json({ uuid: u.uuid, name: u.name, role: u.role });
    }

    // 内部 API(浏览器使用) 与 外部 API(Bearer 使用) -- 行为相同,合并
    const body = (method === 'POST' || method === 'PUT' || method === 'PATCH') ? await readJsonBody(request) : null;
    const baseCtx = { authCtx, env, request, body };

    // 配置 / 订阅
    if ((path === '/api/config' || path === '/api/v1/config') && method === 'GET') {
        return handleGetConfig(baseCtx);
    }
    if ((path === '/api/config' || path === '/api/v1/config') && method === 'PUT') {
        return handleSaveConfig(baseCtx);
    }
    if (path === '/api/subscription/rotate' && method === 'POST') {
        return handleRotateSubToken(baseCtx);
    }
    if (path === '/api/v1/subscriptions' && method === 'GET') {
        return handleListMySubscription(baseCtx);
    }

    // 用户管理(admin)
    if (path === '/api/users' && method === 'GET') {
        return handleListUsers(baseCtx);
    }
    if (path === '/api/users' && method === 'POST') {
        return handleCreateUser(baseCtx);
    }
    const userDelMatch = path.match(/^\/api\/users\/([^\/]+)$/);
    if (userDelMatch && method === 'DELETE') {
        return handleDeleteUser(baseCtx, decodeURIComponent(userDelMatch[1]));
    }

    // ============== /api/v1: 细粒度 CRUD ==============
    // 节点维度
    if (path === '/api/v1/nodes' && method === 'GET') return handleListNodes(baseCtx);
    if (path === '/api/v1/nodes' && method === 'POST') return handleCreateNode(baseCtx);
    if (path === '/api/v1/nodes/batch' && method === 'POST') return handleBatchCreateNodes(baseCtx);
    const nodeIdMatch = path.match(/^\/api\/v1\/nodes\/([^\/]+)$/);
    if (nodeIdMatch) {
        const nid = decodeURIComponent(nodeIdMatch[1]);
        if (method === 'GET') return handleGetNode(baseCtx, nid);
        if (method === 'PUT' || method === 'PATCH') return handleUpdateNode(baseCtx, nid);
        if (method === 'DELETE') return handleDeleteNode(baseCtx, nid);
    }
    // 分组维度
    if (path === '/api/v1/groups' && method === 'GET') return handleListGroups(baseCtx);
    if (path === '/api/v1/groups' && method === 'POST') return handleCreateGroup(baseCtx);
    const groupIdMatch = path.match(/^\/api\/v1\/groups\/([^\/]+)$/);
    if (groupIdMatch) {
        const gid = decodeURIComponent(groupIdMatch[1]);
        if (method === 'GET') return handleGetGroup(baseCtx, gid);
        if (method === 'PUT' || method === 'PATCH') return handleUpdateGroup(baseCtx, gid);
        if (method === 'DELETE') return handleDeleteGroup(baseCtx, gid);
    }
    // 分组成员维度
    const groupNodeMatch = path.match(/^\/api\/v1\/groups\/([^\/]+)\/nodes\/([^\/]+)$/);
    if (groupNodeMatch) {
        const gid = decodeURIComponent(groupNodeMatch[1]);
        const nid = decodeURIComponent(groupNodeMatch[2]);
        if (method === 'POST' || method === 'PUT') return handleAddGroupNode(baseCtx, gid, nid);
        if (method === 'DELETE') return handleRemoveGroupNode(baseCtx, gid, nid);
    }

    return notFound('route not found');
}

export default {
    async fetch(request, env, ctx) {
        try {
            await ensureAdminBootstrap(env);
            return await route(request, env, ctx);
        } catch (e) {
            console.error('[worker] uncaught', e && e.stack || e);
            return json({ error: 'internal error: ' + (e && e.message) }, 500);
        }
    },
};
