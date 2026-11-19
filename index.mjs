/**
 * Vertex Multi-Region server plugin.
 *
 * 1. SillyTavern builds Vertex AI addresses as https://<region>-aiplatform.googleapis.com,
 *    which is right for regions like us-central1 but wrong for Google's multi-region
 *    endpoints. With Region set to "us" or "eu", this rewrites the address to the real
 *    multi-region host, aiplatform.us.rep.googleapis.com (or .eu.).
 * 2. Experiment: on Vertex generation requests, safety thresholds sent as "OFF" are
 *    changed to "BLOCK_NONE". Set VERTEX_SAFETY_OFF_TO_BLOCK_NONE = false to disable.
 */

import https from 'node:https';

const TAG = '[vertex-multiregion]';
const VERTEX_SAFETY_OFF_TO_BLOCK_NONE = true;

const MULTI_RE = /^(us|eu)-aiplatform\.googleapis\.com$/i;
const VERTEX_HOST_RE = /(^|\.|-)aiplatform\.(?:[a-z]+\.rep\.)?googleapis\.com$/i;
const GENERATE_RE = /:(stream)?generateContent\b/i;
const realHost = (region) => `aiplatform.${region.toLowerCase()}.rep.googleapis.com`;

let original = null;

/** Rewrite the multi-region host. Returns { args, host, path } describing the request. */
function inspectAndRewrite(args) {
    let host = null;
    let path = null;
    let changed = false;

    const out = args.map((a) => {
        if (typeof a === 'string' || a instanceof URL) {
            let url;
            try { url = new URL(String(a)); } catch { return a; }
            const m = url.hostname.match(MULTI_RE);
            if (m) { url.hostname = realHost(m[1]); changed = true; }
            host = url.hostname;
            path = path ?? (url.pathname + url.search);
            if (!m) return a;
            return typeof a === 'string' ? url.toString() : url;
        }
        if (a && typeof a === 'object' && typeof a !== 'function') {
            if (typeof a.path === 'string') path = a.path;
            const h = a.hostname || a.host;
            if (typeof h === 'string') {
                const bare = h.split(':')[0];
                host = host ?? bare;
                const m = bare.match(MULTI_RE);
                if (m) {
                    changed = true;
                    host = realHost(m[1]);
                    const next = { ...a, hostname: host };
                    delete next.host;
                    if (next.servername) next.servername = host;
                    if (next.headers && (next.headers.host || next.headers.Host)) {
                        next.headers = { ...next.headers };
                        delete next.headers.host;
                        delete next.headers.Host;
                    }
                    return next;
                }
            }
        }
        return a;
    });

    return { args: changed ? out : args, host, path, changed };
}

/** Buffer the request body so the safety thresholds can be adjusted before sending. */
function patchSafety(req) {
    const write = req.write;
    const end = req.end;
    const chunks = [];

    req.write = function (chunk, encoding, cb) {
        if (typeof encoding === 'function') [cb, encoding] = [encoding, undefined];
        if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        if (cb) process.nextTick(cb);
        return true;
    };

    req.end = function (chunk, encoding, cb) {
        if (typeof chunk === 'function') [cb, chunk] = [chunk, undefined];
        if (typeof encoding === 'function') [cb, encoding] = [encoding, undefined];
        if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        req.write = write;
        req.end = end;

        let body = Buffer.concat(chunks);
        if (body.length && body[0] === 0x7b) {
            try {
                const json = JSON.parse(body.toString('utf8'));
                let count = 0;
                for (const s of json.safetySettings ?? json.safety_settings ?? []) {
                    if (s && s.threshold === 'OFF') { s.threshold = 'BLOCK_NONE'; count++; }
                }
                if (count) {
                    body = Buffer.from(JSON.stringify(json), 'utf8');
                    console.log(`${TAG} safety thresholds OFF -> BLOCK_NONE (${count})`);
                }
            } catch { /* not JSON, send unchanged */ }
        }
        if (!req.headersSent) req.setHeader('Content-Length', body.length);
        if (body.length) write.call(req, body);
        return end.call(req, cb);
    };
}

export const info = {
    id: 'vertex-multiregion',
    name: 'Vertex Multi-Region',
    description: 'Lets Vertex AI use the "us" and "eu" multi-region endpoints.',
};

export async function init() {
    original = https.request;
    https.request = function (...args) {
        const r = inspectAndRewrite(args);
        if (r.changed) console.log(`${TAG} routed request to the multi-region endpoint`);
        const req = original.apply(this, r.args);
        if (VERTEX_SAFETY_OFF_TO_BLOCK_NONE && r.host && VERTEX_HOST_RE.test(r.host) && r.path && GENERATE_RE.test(r.path)) {
            patchSafety(req);
        }
        return req;
    };
    console.log(`${TAG} loaded`);
}

export async function exit() {
    if (original) https.request = original;
    original = null;
}
