'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildRequestSecurityPolicy,
    isAllowedRequestSource,
    isAuthorizedWebSocketRequest,
    isSameOriginBrowserRequest
} = require('./request-security');

function request(remoteAddress, headers = {}, url = '/') {
    const normalizedHeaders = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
    );
    return {
        url,
        headers: normalizedHeaders,
        socket: { remoteAddress },
        get(name) {
            return normalizedHeaders[String(name).toLowerCase()];
        }
    };
}

test('only the Home Assistant ingress proxy is trusted by default', () => {
    const policy = buildRequestSecurityPolicy({});
    assert.equal(isAllowedRequestSource(request('172.30.32.2'), policy), true);
    assert.equal(isAllowedRequestSource(request('::ffff:172.30.32.2'), policy), true);
    assert.equal(isAllowedRequestSource(request('172.30.33.9', {
        'x-forwarded-for': '172.30.32.2'
    }), policy), false);
});

test('loopback is limited to explicitly internal routes unless development access is enabled', () => {
    const defaultPolicy = buildRequestSecurityPolicy({});
    const loopbackRequest = request('127.0.0.1');
    assert.equal(isAllowedRequestSource(loopbackRequest, defaultPolicy), false);
    assert.equal(isAllowedRequestSource(loopbackRequest, defaultPolicy, { allowLoopback: true }), true);

    const developmentPolicy = buildRequestSecurityPolicy({
        IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT: 'true'
    });
    assert.equal(isAllowedRequestSource(loopbackRequest, developmentPolicy), true);
    assert.equal(isAllowedRequestSource(request('192.168.1.50'), developmentPolicy), true);
});

test('sensitive browser requests require a matching Origin or Referer', () => {
    const host = 'homeassistant.local:8123';
    const httpsHeaders = { host, 'x-forwarded-proto': 'https' };
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', httpsHeaders)), false);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        referer: `https://${host}/api/hassio_ingress/token/`
    })), true);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        referer: `https://${host}/`
    })), true);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        origin: 'https://evil.example'
    })), false);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        origin: `https://${host}`,
        referer: 'https://evil.example/'
    })), false);
});

test('browser-declared Sec-Fetch-Site authorizes requests with no Origin or Referer', () => {
    const host = 'homeassistant.local:8123';
    const httpsHeaders = { host, 'x-forwarded-proto': 'https' };
    // Same-origin GET fetches send no Origin, and privacy tooling can strip
    // Referer; the browser-set Sec-Fetch-Site header must carry the check.
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        'sec-fetch-site': 'same-origin'
    })), true);
    // A browser-labeled cross-site request stays rejected even when the other
    // provenance headers look right.
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        'sec-fetch-site': 'cross-site',
        origin: `https://${host}`,
        referer: `https://${host}/`
    })), false);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        'sec-fetch-site': 'same-site',
        origin: `https://${host}`
    })), false);
    // Direct navigation falls back to the Origin/Referer requirement.
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...httpsHeaders,
        'sec-fetch-site': 'none'
    })), false);
});

test('the UI request marker covers plain-HTTP ingress without weakening provenance checks', () => {
    const plainHttpIngress = {
        host: 'homeassistant.local:8123',
        'x-forwarded-host': 'homeassistant.local:8123',
        'x-forwarded-proto': 'http'
    };

    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', plainHttpIngress)), false);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...plainHttpIngress,
        'x-codex-terminal-request': 'wrong'
    })), false);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...plainHttpIngress,
        'x-codex-terminal-request': '1'
    })), true);

    for (const fetchSite of ['cross-site', 'same-site', 'none']) {
        assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
            ...plainHttpIngress,
            'sec-fetch-site': fetchSite,
            'x-codex-terminal-request': '1'
        })), false);
    }

    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...plainHttpIngress,
        origin: 'https://evil.example',
        'x-codex-terminal-request': '1'
    })), false);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...plainHttpIngress,
        referer: 'https://evil.example/',
        'x-codex-terminal-request': '1'
    })), false);
});

test('X-Forwarded-Host restores origin matching when a proxy rewrites Host', () => {
    const browserHost = 'ha.example.com';
    const rewrittenHeaders = {
        host: '172.30.32.1:8099',
        'x-forwarded-host': browserHost,
        'x-forwarded-proto': 'https'
    };
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...rewrittenHeaders,
        referer: `https://${browserHost}/api/hassio_ingress/token/`
    })), true);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...rewrittenHeaders,
        'x-forwarded-host': `${browserHost}, internal.proxy`,
        origin: `https://${browserHost}`
    })), true);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        ...rewrittenHeaders,
        origin: 'https://evil.example'
    })), false);

    const policy = buildRequestSecurityPolicy({});
    assert.equal(isAuthorizedWebSocketRequest(request('172.30.32.2', {
        ...rewrittenHeaders,
        origin: `https://${browserHost}`
    }), policy), true);
});

test('protected POST provenance rejects a scheme downgrade and ambiguous forwarding', () => {
    const host = 'ha.example.com';
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        host,
        'x-forwarded-proto': 'https',
        origin: `http://${host}`
    })), false);
    assert.equal(isSameOriginBrowserRequest(request('172.30.32.2', {
        host,
        'x-forwarded-proto': 'https, http',
        origin: `https://${host}`
    })), false);
});

test('websocket upgrades require both a trusted peer and matching Origin', () => {
    const policy = buildRequestSecurityPolicy({});
    const headers = {
        host: 'homeassistant.local:8123',
        'x-forwarded-proto': 'https',
        origin: 'https://homeassistant.local:8123'
    };
    assert.equal(isAuthorizedWebSocketRequest(request('172.30.32.2', headers), policy), true);
    assert.equal(isAuthorizedWebSocketRequest(request('172.30.33.9', headers), policy), false);
    assert.equal(isAuthorizedWebSocketRequest(request('172.30.32.2', {
        ...headers,
        origin: 'https://evil.example'
    }), policy), false);
    assert.equal(isAuthorizedWebSocketRequest(request('172.30.32.2', {
        host: headers.host
    }), policy), false);
});

test('websocket provenance rejects HTTP Origin on HTTPS ingress', () => {
    const policy = buildRequestSecurityPolicy({});
    assert.equal(isAuthorizedWebSocketRequest(request('172.30.32.2', {
        host: 'ha.example.com',
        'x-forwarded-proto': 'https',
        origin: 'http://ha.example.com'
    }), policy), false);
});
