const enc = new TextEncoder();
let warnedPartialConfig = false;

export const COOKIE_NAME = 'calpher_auth';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const HANDOFF_TTL_SECONDS = 90;

function normalizeOrigin(value) {
    if (!value) return '';
    try { return new URL(value).origin; } catch (e) { return ''; }
}

export function getAuthMode(env) {
    const origin = normalizeOrigin(env.AUTH_MASTER_ORIGIN);
    const secret = String(env.AUTH_COOKIE_SECRET || '').trim();
    if (Boolean(origin) !== Boolean(secret) && !warnedPartialConfig) {
        warnedPartialConfig = true;
        console.warn('[auth] AUTH_MASTER_ORIGIN 与 AUTH_COOKIE_SECRET 未同时配置，已使用独立站模式');
    }
    return origin && secret ? 'federated' : 'standalone';
}

async function hmacKey(secret) {
    if (!secret) throw new Error('AUTH_COOKIE_SECRET 未配置');
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function toBase64Url(bytes) {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const byte of view) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

async function signToken(env, payload) {
    const body = toBase64Url(enc.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign('HMAC', await hmacKey(String(env.AUTH_COOKIE_SECRET || '').trim()), enc.encode(body));
    return `${body}.${toBase64Url(sig)}`;
}

async function verifyToken(env, token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    try {
        const valid = await crypto.subtle.verify(
            'HMAC',
            await hmacKey(String(env.AUTH_COOKIE_SECRET || '').trim()),
            fromBase64Url(parts[1]),
            enc.encode(parts[0]),
        );
        if (!valid) return null;
        return JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    } catch (e) {
        return null;
    }
}

function readCookies(request, name) {
    const header = request.headers.get('Cookie') || '';
    const values = [];
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index >= 0 && part.slice(0, index).trim() === name) {
            try {
                values.push(decodeURIComponent(part.slice(index + 1).trim()));
            } catch (e) {
                // Ignore a malformed duplicate and continue looking for a valid session.
            }
        }
    }
    return values;
}

function cookieAttributes(request, env, maxAge, options = {}) {
    const parent = String(env.PARENT_DOMAIN || '').trim().replace(/^\./, '').toLowerCase();
    const host = new URL(request.url).hostname.toLowerCase();
    const parentScoped = parent && (host === parent || host.endsWith(`.${parent}`));
    const partitioned = Boolean(options.partitioned) && !parentScoped;
    const parts = [
        'Path=/',
        'HttpOnly',
        'Secure',
        `SameSite=${partitioned || (!parentScoped && getAuthMode(env) === 'federated') ? 'None' : 'Lax'}`,
        `Max-Age=${maxAge}`,
    ];
    if (parentScoped) parts.splice(1, 0, `Domain=${parent}`);
    if (partitioned) parts.push('Partitioned');
    return parts.join('; ');
}

export function buildSessionCookie(sid, request, env, options = {}) {
    return `${COOKIE_NAME}=${encodeURIComponent(sid)}; ${cookieAttributes(request, env, SESSION_TTL_SECONDS, options)}`;
}

export function buildLogoutCookie(request, env, options = {}) {
    return `${COOKIE_NAME}=; ${cookieAttributes(request, env, 0, options)}`;
}

export async function createSession(env, user, now = Date.now()) {
    const iat = Math.floor(now / 1000);
    return signToken(env, {
        v: 1, typ: 'session', sub: String(user.name || user.sub || 'admin'),
        role: user.role || 'user', iat, exp: iat + SESSION_TTL_SECONDS,
    });
}

export async function authenticate(request, env, now = Date.now()) {
    const current = Math.floor(now / 1000);
    for (const sid of readCookies(request, COOKIE_NAME)) {
        const payload = await verifyToken(env, sid);
        if (!payload || payload.v !== 1 || payload.typ !== 'session' || !payload.sub) continue;
        if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.iat > current + 10 || payload.exp <= current) continue;
        return { user: { name: payload.sub, role: payload.role || 'user' }, sid, source: 'calpher' };
    }
    return { user: null, sid: null };
}

export async function verifyHandoffTicket(env, ticket, audience, now = Date.now()) {
    const payload = await verifyToken(env, ticket);
    const current = Math.floor(now / 1000);
    const aud = normalizeOrigin(audience);
    if (!payload || payload.v !== 1 || payload.typ !== 'handoff') return null;
    if (!payload.sub || !payload.nonce || payload.aud !== aud) return null;
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= current || payload.iat > current + 10) return null;
    if (current - payload.iat > HANDOFF_TTL_SECONDS + 10) return null;
    try {
        if (new URL(payload.returnUrl).origin !== aud) return null;
    } catch (e) {
        return null;
    }
    return { user: { name: payload.sub, role: payload.role || 'user' }, returnUrl: payload.returnUrl };
}

export function buildMasterLoginUrl(request, env, targetUrl = request.url) {
    const origin = normalizeOrigin(env.AUTH_MASTER_ORIGIN);
    if (!origin) return '';
    const login = new URL('/login', origin);
    login.searchParams.set('redirect', new URL(targetUrl, request.url).toString());
    return login.toString();
}
