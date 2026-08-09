'use strict';

const DEFAULT_INGRESS_PROXY_ADDRESSES = ['172.30.32.2'];
const BROWSER_REQUEST_HEADER = 'x-codex-terminal-request';
const BROWSER_REQUEST_VALUE = '1';

function parseExplicitBoolean(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function normalizeRemoteAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    if (address.startsWith('::ffff:')) {
        return address.slice('::ffff:'.length);
    }
    return address;
}

function isLoopbackAddress(value) {
    const address = normalizeRemoteAddress(value);
    return address === '127.0.0.1' || address === '::1';
}

function parseTrustedIngressAddresses(value) {
    const addresses = String(value || '')
        .split(',')
        .map(normalizeRemoteAddress)
        .filter(Boolean);
    return addresses.length > 0 ? addresses : DEFAULT_INGRESS_PROXY_ADDRESSES;
}

function buildRequestSecurityPolicy(env = process.env) {
    return {
        trustedIngressAddresses: new Set(parseTrustedIngressAddresses(env.HA_INGRESS_PROXY_ADDRESSES)),
        allowLoopbackDevelopment: parseExplicitBoolean(env.IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT)
    };
}

function requestRemoteAddress(req) {
    return normalizeRemoteAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
}

function isAllowedRequestSource(req, policy, options = {}) {
    const remoteAddress = requestRemoteAddress(req);
    if (policy.trustedIngressAddresses.has(remoteAddress)) {
        return true;
    }
    if (options.allowLoopback && isLoopbackAddress(remoteAddress)) {
        return true;
    }
    // This switch exists only for explicit local development. Docker-published
    // traffic normally arrives from the bridge gateway rather than 127.0.0.1,
    // so the opt-in must cover that source as well. Production never sets it.
    return policy.allowLoopbackDevelopment;
}

function requestHeader(req, name) {
    if (typeof req?.get === 'function') {
        return req.get(name);
    }
    return req?.headers?.[String(name).toLowerCase()];
}

function requestExternalProtocol(req) {
    const forwarded = String(requestHeader(req, 'x-forwarded-proto') || '').trim().toLowerCase();
    if (forwarded) {
        // Multiple values are ambiguous and may represent an untrusted value
        // that was appended instead of replaced by a proxy.
        if (forwarded.includes(',') || (forwarded !== 'http' && forwarded !== 'https')) {
            return '';
        }
        return forwarded;
    }
    return req?.socket?.encrypted ? 'https' : 'http';
}

function normalizedHeaderToken(req, name) {
    return String(requestHeader(req, name) || '').trim().toLowerCase();
}

function requestHostCandidates(req) {
    const candidates = [];
    const host = normalizedHeaderToken(req, 'host');
    if (host) {
        candidates.push(host);
    }
    // Proxy chains in front of Home Assistant can rewrite Host, but ingress
    // always records the browser-facing host in X-Forwarded-Host. Only trusted
    // ingress peers reach these routes, so the header is as reliable as Host.
    // The first entry is the client-facing host when chained proxies append.
    const forwardedHost = normalizedHeaderToken(req, 'x-forwarded-host').split(',')[0].trim();
    if (forwardedHost && !candidates.includes(forwardedHost)) {
        candidates.push(forwardedHost);
    }
    return candidates;
}

function headerMatchesRequestHost(req, headerName) {
    const value = requestHeader(req, headerName);
    const hosts = requestHostCandidates(req);
    if (!value || hosts.length === 0) {
        return false;
    }

    try {
        const parsed = new URL(value);
        const externalProtocol = requestExternalProtocol(req);
        return Boolean(externalProtocol) &&
            parsed.protocol === `${externalProtocol}:` &&
            !parsed.username &&
            !parsed.password &&
            hosts.includes(parsed.host.toLowerCase());
    } catch {
        return false;
    }
}

function isSameOriginBrowserRequest(req) {
    // Sec-Fetch-Site is attached by the browser itself and cannot be forged by
    // page scripts, so it is the strongest same-origin proof available.
    const fetchSite = normalizedHeaderToken(req, 'sec-fetch-site');
    if (fetchSite === 'same-origin') {
        return true;
    }
    if (fetchSite === 'same-site' || fetchSite === 'cross-site') {
        return false;
    }

    const origin = requestHeader(req, 'origin');
    const referer = requestHeader(req, 'referer');
    if (origin || referer) {
        return (!origin || headerMatchesRequestHost(req, 'origin')) &&
            (!referer || headerMatchesRequestHost(req, 'referer'));
    }

    // Plain-HTTP LAN origins are not "potentially trustworthy", so browsers
    // may omit Sec-Fetch-Site. Same-origin GETs also omit Origin, and privacy
    // controls can suppress Referer. The UI therefore supplies a fixed,
    // non-CORS-safelisted marker. It is accepted only after the global trusted
    // ingress-peer check and only when no browser provenance contradicts it.
    // Cross-origin page scripts cannot attach this header unless the service
    // opts into their CORS preflight, which it does not.
    return !fetchSite &&
        normalizedHeaderToken(req, BROWSER_REQUEST_HEADER) === BROWSER_REQUEST_VALUE;
}

function isAuthorizedWebSocketRequest(req, policy) {
    return isAllowedRequestSource(req, policy) && headerMatchesRequestHost(req, 'origin');
}

module.exports = {
    DEFAULT_INGRESS_PROXY_ADDRESSES,
    buildRequestSecurityPolicy,
    headerMatchesRequestHost,
    isAllowedRequestSource,
    isAuthorizedWebSocketRequest,
    isLoopbackAddress,
    isSameOriginBrowserRequest,
    normalizeRemoteAddress,
    parseExplicitBoolean,
    parseTrustedIngressAddresses,
    requestExternalProtocol,
    requestRemoteAddress
};
