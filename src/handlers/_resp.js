export function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
    });
}

export function text(body, status = 200, extraHeaders = {}) {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders },
    });
}

export function badRequest(msg) { return json({ error: msg }, 400); }
export function unauthorized(msg = 'unauthorized') { return json({ error: msg }, 401); }
export function forbidden(msg = 'forbidden') { return json({ error: msg }, 403); }
export function notFound(msg = 'not found') { return json({ error: msg }, 404); }
export function serverError(msg = 'server error') { return json({ error: msg }, 500); }
