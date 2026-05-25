// 业务标识: kv key 都按 user:<uuid> / config:<uuid> / subtoken:<token> / session:<sid> 划分
// 注意: 此处函数都接受 env.CALPHER_KV 实例,不直接读写其他 KV

const PREFIX = {
    USER: 'user:',
    CONFIG: 'config:',
    SUBTOKEN: 'subtoken:',
    SESSION: 'session:',
};

export const kvKey = {
    user: uuid => PREFIX.USER + uuid,
    config: uuid => PREFIX.CONFIG + uuid,
    subToken: token => PREFIX.SUBTOKEN + token,
    session: sid => PREFIX.SESSION + sid,
};

export async function getUser(kv, uuid) {
    if (!uuid) return null;
    const raw = await kv.get(kvKey.user(uuid));
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (e) {
        console.warn('[kv] user JSON parse failed for uuid=' + uuid, e);
        return null;
    }
}

export async function putUser(kv, user) {
    if (!user || !user.uuid) throw new Error('user.uuid required');
    await kv.put(kvKey.user(user.uuid), JSON.stringify(user));
}

export async function deleteUser(kv, uuid) {
    await kv.delete(kvKey.user(uuid));
}

export async function getConfig(kv, uuid) {
    const raw = await kv.get(kvKey.config(uuid));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function putConfig(kv, uuid, cfg) {
    await kv.put(kvKey.config(uuid), JSON.stringify(cfg));
}

export async function deleteConfig(kv, uuid) {
    await kv.delete(kvKey.config(uuid));
}

export async function listUsers(kv) {
    const out = [];
    let cursor = undefined;
    do {
        const page = await kv.list({ prefix: PREFIX.USER, cursor, limit: 1000 });
        for (const k of page.keys) {
            const uuid = k.name.slice(PREFIX.USER.length);
            const u = await getUser(kv, uuid);
            if (u) out.push(u);
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
}

export async function setSubToken(kv, token, uuid) {
    await kv.put(kvKey.subToken(token), uuid);
}
export async function getSubTokenOwner(kv, token) {
    return await kv.get(kvKey.subToken(token));
}
export async function deleteSubToken(kv, token) {
    if (token) await kv.delete(kvKey.subToken(token));
}

export async function setSession(kv, sid, uuid) {
    // 30 天 TTL
    await kv.put(kvKey.session(sid), uuid, { expirationTtl: 60 * 60 * 24 * 30 });
}
export async function getSession(kv, sid) {
    if (!sid) return null;
    return await kv.get(kvKey.session(sid));
}
export async function deleteSession(kv, sid) {
    if (sid) await kv.delete(kvKey.session(sid));
}
