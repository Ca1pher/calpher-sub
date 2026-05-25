import { getSession, setSession, deleteSession, getUser, putUser, kvKey } from './kv.js';
import { isValidUuid } from './uuid.js';

const COOKIE_NAME = 'cs_sid';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 天

export function parseCookies(request) {
    const header = request.headers.get('Cookie') || '';
    const out = {};
    header.split(/;\s*/).forEach(kv => {
        if (!kv) return;
        const idx = kv.indexOf('=');
        if (idx === -1) return;
        out[kv.slice(0, idx).trim()] = decodeURIComponent(kv.slice(idx + 1).trim());
    });
    return out;
}

export function buildSessionCookie(sid, maxAge = SESSION_TTL) {
    const parts = [
        `${COOKIE_NAME}=${encodeURIComponent(sid)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAge}`,
        // 'Secure', // 在 *.workers.dev / 自定义域 HTTPS 部署时浏览器需要;本地开发 wrangler dev 不带证书,加上会导致 cookie 写不进
    ];
    if (maxAge > 0) parts.push('Secure');
    return parts.join('; ');
}

export function buildLogoutCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// 从 cookie 或 Authorization: Bearer 中解析当前用户
// 返回 { user, source }: source = 'session' | 'bearer'
export async function authenticate(request, env) {
    const kv = env.CALPHER_KV;

    // 先看 Authorization: Bearer <UUID>(外部 API 直接用 UUID)
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        if (isValidUuid(token)) {
            await ensureAdminBootstrap(env);
            const user = await getUser(kv, token);
            if (user) {
                console.info('[auth] bearer accepted uuid=' + token + ' role=' + user.role);
                return { user, source: 'bearer' };
            }
            console.warn('[auth] bearer UUID not registered uuid=' + token);
        }
    }

    // 再看 cookie session
    const cookies = parseCookies(request);
    const sid = cookies[COOKIE_NAME];
    if (sid) {
        await ensureAdminBootstrap(env);
        const uuid = await getSession(kv, sid);
        if (uuid) {
            const user = await getUser(kv, uuid);
            if (user) return { user, source: 'session', sid };
            console.warn('[auth] session points to missing user uuid=' + uuid);
        }
    }
    return { user: null };
}

// 平台首启自动把 ADMIN_UUID 注册成 admin 用户(只创建一次)
let bootstrapped = false;
export async function ensureAdminBootstrap(env) {
    if (bootstrapped) return;
    const adminUuid = (env.ADMIN_UUID || '').trim();
    if (!adminUuid) {
        bootstrapped = true;
        console.warn('[bootstrap] ADMIN_UUID env var not set -- 平台没有初始管理员');
        return;
    }
    if (!isValidUuid(adminUuid)) {
        bootstrapped = true;
        console.warn('[bootstrap] ADMIN_UUID 格式不是 uuid v4:' + adminUuid);
        return;
    }
    const existing = await getUser(env.CALPHER_KV, adminUuid);
    if (existing) {
        // 已存在,确保 role=admin(防止被普通用户覆盖)
        if (existing.role !== 'admin') {
            existing.role = 'admin';
            await putUser(env.CALPHER_KV, existing);
            console.info('[bootstrap] 已把 ADMIN_UUID 用户升级为 admin uuid=' + adminUuid);
        }
    } else {
        await putUser(env.CALPHER_KV, {
            uuid: adminUuid,
            name: 'admin',
            role: 'admin',
            createdAt: Date.now(),
        });
        console.info('[bootstrap] 已创建初始 admin uuid=' + adminUuid);
    }
    bootstrapped = true;
}

export async function loginByUuid(env, uuid) {
    if (!isValidUuid(uuid)) throw new Error('UUID 格式不正确');
    await ensureAdminBootstrap(env);
    const user = await getUser(env.CALPHER_KV, uuid);
    if (!user) throw new Error('UUID 不存在,请联系管理员开通');
    // 生成 session id
    const sid = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await setSession(env.CALPHER_KV, sid, uuid);
    console.info('[auth] login ok uuid=' + uuid + ' role=' + user.role);
    return { user, sid };
}

export async function logout(env, sid) {
    if (sid) await deleteSession(env.CALPHER_KV, sid);
}
