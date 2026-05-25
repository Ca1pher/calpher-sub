const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(s) {
    return typeof s === 'string' && UUID_RE.test(s);
}

export function randomUuidV4() {
    // workers V8 提供 crypto.randomUUID
    return crypto.randomUUID();
}

// 32 字节十六进制(订阅 token / session id)
export function randomToken(byteLen = 16) {
    const buf = new Uint8Array(byteLen);
    crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
