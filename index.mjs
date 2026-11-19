/**
 * Vertex Multi-Region server plugin.
 *
 * SillyTavern builds Vertex AI addresses as https://<region>-aiplatform.googleapis.com,
 * which is right for regions like us-central1 but wrong for Google's multi-region
 * endpoints. With Region set to "us" or "eu", SillyTavern would call
 * us-aiplatform.googleapis.com (which doesn't exist); this plugin rewrites that to
 * the real multi-region host, aiplatform.us.rep.googleapis.com (or .eu.).
 */

import https from 'node:https';

const TAG = '[vertex-multiregion]';
const HOST_RE = /^(us|eu)-aiplatform\.googleapis\.com$/i;
const realHost = (region) => `aiplatform.${region.toLowerCase()}.rep.googleapis.com`;

let original = null;

function rewriteUrl(value) {
    try {
        const url = new URL(String(value));
        const m = url.hostname.match(HOST_RE);
        if (!m) return null;
        url.hostname = realHost(m[1]);
        return url;
    } catch {
        return null;
    }
}

function rewriteArgs(args) {
    let changed = false;
    const out = args.map((a) => {
        if (typeof a === 'string' || a instanceof URL) {
            const url = rewriteUrl(a);
            if (url) { changed = true; return typeof a === 'string' ? url.toString() : url; }
            return a;
        }
        if (a && typeof a === 'object' && typeof a !== 'function') {
            const host = a.hostname || a.host;
            const m = typeof host === 'string' && host.split(':')[0].match(HOST_RE);
            if (m) {
                changed = true;
                const next = { ...a, hostname: realHost(m[1]) };
                delete next.host;
                if (next.servername) next.servername = realHost(m[1]);
                if (next.headers && (next.headers.host || next.headers.Host)) {
                    next.headers = { ...next.headers };
                    delete next.headers.host;
                    delete next.headers.Host;
                }
                return next;
            }
        }
        return a;
    });
    return changed ? out : null;
}

export const info = {
    id: 'vertex-multiregion',
    name: 'Vertex Multi-Region',
    description: 'Lets Vertex AI use the "us" and "eu" multi-region endpoints.',
};

export async function init() {
    original = https.request;
    https.request = function (...args) {
        const rewritten = rewriteArgs(args);
        if (rewritten) {
            console.log(`${TAG} routed request to the multi-region endpoint`);
            return original.apply(this, rewritten);
        }
        return original.apply(this, args);
    };
    console.log(`${TAG} loaded`);
}

export async function exit() {
    if (original) https.request = original;
    original = null;
}
