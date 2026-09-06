'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const VALID_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);
const MINIMAL_PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close((err) => err ? reject(err) : resolve(port));
        });
    });
}

async function waitForHealth(baseUrl, child) {
    // Fresh npm trees on macOS can incur a one-time filesystem security scan
    // while Express is loaded. Keep the test deterministic without weakening
    // the service's actual startup check.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`image service exited early with ${child.exitCode}`);
        }
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) {
                return;
            }
        } catch {
            // Retry while the process binds its socket.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('image service did not become healthy');
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (err) {
            if (err.code === 'ESRCH') {
                return;
            }
            throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`process ${pid} survived its cleanup deadline`);
}

async function startServer(t, allowLoopbackDevelopment, buildExtraEnvironment = () => ({})) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctp-server-test-'));
    const runtimeDirectory = path.join(directory, 'runtime');
    const shellDispatchSocket = path.join(runtimeDirectory, 'shell-dispatch.sock');
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    const port = await reservePort();
    const extraEnvironment = buildExtraEnvironment(directory);
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname,
        env: {
            ...process.env,
            IMAGE_SERVICE_PORT: String(port),
            TTYD_PORT: String(port + 1),
            UPLOAD_DIR: path.join(directory, 'uploads'),
            HA_CONFIG_DIR: directory,
            HA_MONITOR_STATE_FILE: path.join(directory, 'monitor.json'),
            HA_MONITOR_HISTORY_FILE: path.join(directory, 'history.jsonl'),
            CHANGE_DESK_DISPATCH_FILE: path.join(directory, 'dispatch.json'),
            CHANGE_DESK_REPORT_DIR: path.join(directory, 'reports'),
            CHANGE_DESK_MALL_COP_MEMORY_FILE: path.join(directory, 'memory.json'),
            NODE_ENV: 'test',
            IMAGE_SERVICE_TEST_MODE: 'true',
            IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT: allowLoopbackDevelopment ? 'true' : 'false',
            SHELL_DISPATCH_SOCKET_PATH: shellDispatchSocket,
            SIGNIN_TRUSTED_PROCESS_USER: 'root',
            ...extraEnvironment
        },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    t.after(() => {
        child.kill('SIGTERM');
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForHealth(baseUrl, child);
        const socketDeadline = Date.now() + 2000;
        while (!fs.existsSync(shellDispatchSocket) && Date.now() < socketDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!fs.existsSync(shellDispatchSocket)) {
            throw new Error('internal shell dispatch socket did not become ready');
        }
    } catch (err) {
        throw new Error(`${err.message}\n${stderr}`);
    }
    return { baseUrl, directory, child, shellDispatchSocket, stderr: () => stderr };
}

async function unixJsonRequest(socketPath, body) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            socketPath,
            path: '/terminal-shell-command',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (response) => {
            let payload = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { payload += chunk; });
            response.on('end', () => resolve({
                status: response.statusCode,
                body: payload ? JSON.parse(payload) : {}
            }));
        });
        request.on('error', reject);
        request.end(JSON.stringify(body));
    });
}

async function startUnixTerminalBackend(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctp-ttyd-socket-test-'));
    const socketPath = path.join(directory, 'ttyd.sock');
    const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'text/plain');
        response.end(`unix-terminal:${request.url}`);
    });
    server.on('upgrade', (request, socket) => {
        socket.end([
            'HTTP/1.1 101 Switching Protocols',
            'Connection: Upgrade',
            'Upgrade: websocket',
            `X-Upstream-Path: ${request.url}`,
            '',
            'unix-terminal-upgrade'
        ].join('\r\n'));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    t.after(() => {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return socketPath;
}

async function startCallbackListener(t, port = 1455) {
    const paths = [];
    let connections = 0;
    const server = http.createServer((request, response) => {
        paths.push(request.url);
        response.statusCode = 200;
        response.end('received');
    });
    server.on('connection', () => {
        connections += 1;
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    t.after(() => server.close());
    return { paths, connectionCount: () => connections };
}

async function rawWebSocketUpgrade(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let response = '';
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.on('data', (chunk) => {
            response += chunk;
        });
        socket.on('end', () => resolve(response));
        socket.on('connect', () => {
            socket.write([
                'GET /terminal/ws?client=test HTTP/1.1',
                `Host: 127.0.0.1:${port}`,
                `Origin: http://127.0.0.1:${port}`,
                'Connection: Upgrade',
                'Upgrade: websocket',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                '',
                ''
            ].join('\r\n'));
        });
    });
}

test('direct loopback access is denied by default while the local health probe remains available', async (t) => {
    const { baseUrl } = await startServer(t, false);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('referrer-policy'), 'strict-origin');
    assert.equal((await fetch(`${baseUrl}/config`)).status, 403);
});

test('terminal HTTP and WebSocket traffic reaches a ttyd Unix socket', async (t) => {
    const ttydSocket = await startUnixTerminalBackend(t);
    const { baseUrl } = await startServer(t, true, () => ({
        TTYD_SOCKET_PATH: ttydSocket
    }));

    const terminal = await fetch(`${baseUrl}/terminal/probe?client=test`);
    assert.equal(terminal.status, 200);
    assert.equal(await terminal.text(), 'unix-terminal:/probe?client=test');

    const port = Number.parseInt(new URL(baseUrl).port, 10);
    const upgrade = await rawWebSocketUpgrade(port);
    assert.match(upgrade, /^HTTP\/1\.1 101 Switching Protocols/m);
    assert.match(upgrade, /X-Upstream-Path: \/ws\?client=test/i);
    assert.match(upgrade, /unix-terminal-upgrade/);
});

test('consultant setup fails closed when the shared shell has a descendant', async (t) => {
    const { baseUrl, directory } = await startServer(t, true, (root) => {
        const binDirectory = path.join(root, 'bin');
        fs.mkdirSync(binDirectory);
        const consult = path.join(binDirectory, 'consult');
        fs.writeFileSync(consult, `#!/bin/sh
printf '%s\n' '{"consultants":[{"id":"claude","label":"Claude Code","installed":true,"authHelper":"claude-auth-helper"}]}'
`, { mode: 0o755 });
        fs.writeFileSync(path.join(binDirectory, 'tmux'), `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\n' ;;
    display-message) printf 'bash 4242\n' ;;
    *) printf '%s\n' "$*" >> "$TMUX_CALL_LOG" ;;
esac
`, { mode: 0o755 });
        fs.writeFileSync(path.join(binDirectory, 'ps'), `#!/bin/sh
printf '%s\n' '4242 1 root /bin/bash -l' '4243 4242 root /bin/bash /usr/local/bin/claude-auth-helper'
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            CONSULT_BIN: consult,
            TMUX_CALL_LOG: path.join(root, 'tmux-calls')
        };
    });

    const response = await fetch(`${baseUrl}/consultant-setup`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'claude' })
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /busy/i);
    assert.equal(fs.existsSync(path.join(directory, 'tmux-calls')), false);
});

test('settings and consultant setup share one bounded consultant-status lookup', async (t) => {
    let invocationFile;
    const { baseUrl } = await startServer(t, true, (directory) => {
        invocationFile = path.join(directory, 'consult-invocations');
        const consult = path.join(directory, 'consult');
        fs.writeFileSync(consult, `#!/bin/sh
printf '%s\\n' invoked >> "$CONSULT_INVOCATION_FILE"
sleep 1
printf '%s\\n' '{"consultants":[{"id":"claude","label":"Claude Code","installed":true,"authenticated":true,"supportsEffort":true,"effortLevels":["high"]}]}'
`, { mode: 0o755 });
        return {
            CONSULT_BIN: consult,
            CONSULT_INVOCATION_FILE: invocationFile,
            SETTINGS_FILE: path.join(directory, 'settings.json')
        };
    });

    const [readResponse, writeResponse, setupResponse] = await Promise.all([
        fetch(`${baseUrl}/settings`, { headers: { Origin: baseUrl } }),
        fetch(`${baseUrl}/settings`, {
            method: 'POST',
            headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
            body: JSON.stringify({ defaultConsultant: 'claude' })
        }),
        fetch(`${baseUrl}/consultant-setup`, {
            method: 'POST',
            headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: 'unknown' })
        })
    ]);

    assert.equal(readResponse.status, 200);
    assert.equal(writeResponse.status, 200);
    assert.equal(setupResponse.status, 400);
    assert.equal(fs.readFileSync(invocationFile, 'utf8').trim().split('\n').length, 1);
});

test('settings forward consultant defaults and accept effort for an unknown custom model', async (t) => {
    const consultant = {
        id: 'codex',
        label: 'Codex',
        installed: true,
        signedIn: true,
        ready: true,
        supportsModel: true,
        supportsEffort: true,
        effortDependsOnModel: true,
        effortLevels: ['low', 'max'],
        effortLevelsByModel: { '': ['low', 'max'] },
        defaultModel: 'gpt-5.6-sol',
        defaultEffort: 'max',
        models: []
    };
    const { baseUrl, directory } = await startServer(t, true, (root) => {
        const consult = path.join(root, 'consult');
        fs.writeFileSync(consult, `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ consultants: [consultant] })}'
`, { mode: 0o755 });
        return {
            CONSULT_BIN: consult,
            SETTINGS_FILE: path.join(root, 'settings.json')
        };
    });

    const getResponse = await fetch(`${baseUrl}/settings`, { headers: { Origin: baseUrl } });
    assert.equal(getResponse.status, 200);
    const settings = await getResponse.json();
    assert.equal(settings.consultants[0].defaultModel, 'gpt-5.6-sol');
    assert.equal(settings.consultants[0].defaultEffort, 'max');

    const postResponse = await fetch(`${baseUrl}/settings`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ consultants: { codex: { model: 'gpt-5.6-sol', effort: 'max' } } })
    });
    assert.equal(postResponse.status, 200);
    const saved = await postResponse.json();
    assert.deepEqual(saved.preferences.consultants.codex, { model: 'gpt-5.6-sol', effort: 'max' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).consultants.codex, {
        model: 'gpt-5.6-sol',
        effort: 'max'
    });
});

test('an allowlisted URL is hidden unless the live process is the matching login CLI', async (t) => {
    const startWithProcess = (args, options = {}) => startServer(t, true, (root) => {
        const binDirectory = path.join(root, 'bin');
        fs.mkdirSync(binDirectory);
        const url = options.url || 'https://auth.openai.com/oauth/authorize?client_id=planted';
        const processUser = options.user || 'root';
        const processLines = options.wrapper
            ? `'4242 1 root /bin/bash -l' '4243 4242 root /bin/bash /opt/scripts/${options.wrapper}' '4244 4243 ${processUser} ${args}'`
            : `'4242 1 root /bin/bash -l' '4243 4242 ${processUser} ${args}'`;
        fs.writeFileSync(path.join(binDirectory, 'tmux'), `#!/bin/sh
case "$1" in
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\n' ;;
            *) printf '100 4242\n' ;;
        esac
        ;;
    capture-pane) printf '%s\n' '${url}' ;;
esac
`, { mode: 0o755 });
        fs.writeFileSync(path.join(binDirectory, 'ps'), `#!/bin/sh
printf '%s\n' ${processLines}
`, { mode: 0o755 });
        return { PATH: `${binDirectory}:${process.env.PATH}` };
    });

    const unrelated = await startWithProcess('codex exec echo-url');
    const hidden = await fetch(`${unrelated.baseUrl}/agent-login-url`, {
        headers: { Origin: unrelated.baseUrl }
    });
    assert.equal(hidden.status, 200);
    assert.equal((await hidden.json()).found, false);

    const login = await startWithProcess('codex login --device-auth');
    const shown = await fetch(`${login.baseUrl}/agent-login-url`, {
        headers: { Origin: login.baseUrl }
    });
    assert.equal(shown.status, 200);
    const payload = await shown.json();
    assert.equal(payload.found, true);
    assert.equal(payload.sourceLabel, 'Codex');
    assert.equal(payload.targetMode, 'codex');

    const argvSpoof = await startWithProcess('/bin/bash -c /tmp/codex login');
    const argvSpoofResponse = await fetch(`${argvSpoof.baseUrl}/agent-login-url`, {
        headers: { Origin: argvSpoof.baseUrl }
    });
    assert.equal((await argvSpoofResponse.json()).found, false);

    const droppedUser = await startWithProcess('codex login --device-auth', { user: 'ctp-kimi' });
    const droppedUserResponse = await fetch(`${droppedUser.baseUrl}/agent-login-url`, {
        headers: { Origin: droppedUser.baseUrl }
    });
    assert.equal((await droppedUserResponse.json()).found, false);

    const ordinaryClaude = await startWithProcess('claude', {
        url: 'https://console.anthropic.com/oauth/authorize?client_id=planted'
    });
    const ordinaryClaudeResponse = await fetch(`${ordinaryClaude.baseUrl}/agent-login-url`, {
        headers: { Origin: ordinaryClaude.baseUrl }
    });
    assert.equal((await ordinaryClaudeResponse.json()).found, false);

    const helperClaude = await startWithProcess('claude', {
        url: 'https://console.anthropic.com/oauth/authorize?client_id=verified',
        wrapper: 'claude-auth-helper.sh'
    });
    const helperClaudeResponse = await fetch(`${helperClaude.baseUrl}/agent-login-url`, {
        headers: { Origin: helperClaude.baseUrl }
    });
    const helperClaudePayload = await helperClaudeResponse.json();
    assert.equal(helperClaudePayload.found, true);
    assert.equal(helperClaudePayload.sourceLabel, 'Claude Code');
});

test('a sign-in code stays bound to the pane that produced the verified URL', async (t) => {
    const { baseUrl, directory } = await startServer(t, true, (root) => {
        const binDirectory = path.join(root, 'bin');
        fs.mkdirSync(binDirectory);
        fs.writeFileSync(path.join(binDirectory, 'tmux'), `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\n' ;;
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\n' ;;
            *) printf '100 4242\n' ;;
        esac
        ;;
    capture-pane) printf '%s\n' 'https://auth.openai.com/oauth/authorize?client_id=verified' ;;
    *) printf '%s\n' "$*" >> "$TMUX_CALL_LOG" ;;
esac
`, { mode: 0o755 });
        fs.writeFileSync(path.join(binDirectory, 'ps'), `#!/bin/sh
printf '%s\n' '4242 1 root /bin/bash -l' '4243 4242 root codex login --device-auth'
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            TMUX_CALL_LOG: path.join(root, 'tmux-calls')
        };
    });

    const linkResponse = await fetch(`${baseUrl}/agent-login-url`, {
        headers: { Origin: baseUrl }
    });
    const link = await linkResponse.json();
    assert.equal(link.targetMode, 'codex');

    const modeResponse = await fetch(`${baseUrl}/terminal-mode`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'raw' })
    });
    assert.equal(modeResponse.status, 200);

    const submit = await fetch(`${baseUrl}/terminal-signin-code`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'one-time-code', mode: link.targetMode, url: link.url })
    });
    assert.equal(submit.status, 200);
    assert.equal((await submit.json()).mode, 'codex');
    const calls = fs.readFileSync(path.join(directory, 'tmux-calls'), 'utf8');
    assert.match(calls, /send-keys -t codex-terminal:0\.0 -l -- one-time-code/);
    assert.doesNotMatch(calls, /send-keys -t codex-terminal:raw-shell\.0 -l -- one-time-code/);
});

test('OAuth callback forwarding requires the verified Codex process to own the listener', async (t) => {
    const callbackListener = await startCallbackListener(t);
    const fallbackListener = await startCallbackListener(t, 1457);
    const { baseUrl, directory } = await startServer(t, true, (root) => {
        const binDirectory = path.join(root, 'bin');
        const loginState = path.join(root, 'login-active');
        const ownerAllowed = path.join(root, 'owner-allowed');
        const ownerLog = path.join(root, 'owner-check');
        fs.mkdirSync(binDirectory);
        fs.writeFileSync(path.join(binDirectory, 'tmux'), `#!/bin/sh
case "$1" in
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\n' ;;
            *) printf '100 4242\n' ;;
        esac
        ;;
    capture-pane) printf '%s\n' 'https://auth.openai.com/oauth/authorize?client_id=verified' ;;
esac
`, { mode: 0o755 });
        fs.writeFileSync(path.join(binDirectory, 'ps'), `#!/bin/sh
printf '%s\n' '4242 1 root /bin/bash -l'
if [ -f "$LOGIN_STATE" ]; then
    printf '%s\n' '4243 4242 root codex login'
fi
`, { mode: 0o755 });
        const ownerCheck = path.join(binDirectory, 'port-owner');
        fs.writeFileSync(ownerCheck, `#!/bin/sh
printf '%s %s\n' "$1" "$2" >> "$OWNER_LOG"
[ -f "$OWNER_ALLOWED" ]
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            LOGIN_STATE: loginState,
            OWNER_ALLOWED: ownerAllowed,
            OWNER_LOG: ownerLog,
            SIGNIN_PORT_OWNER_BIN: ownerCheck
        };
    });
    const body = {
        url: 'http://localhost:1455/auth/callback?code=review-secret&state=review',
        mode: 'codex',
        signInUrl: 'https://auth.openai.com/oauth/authorize?client_id=verified'
    };
    const postCallback = (url = body.url) => fetch(`${baseUrl}/agent-callback-forward`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, url })
    });

    const noLogin = await postCallback();
    assert.equal(noLogin.status, 409);
    assert.deepEqual(callbackListener.paths, []);
    assert.equal(callbackListener.connectionCount(), 0);

    fs.writeFileSync(path.join(directory, 'login-active'), 'yes');
    const wrongOwner = await postCallback();
    assert.equal(wrongOwner.status, 409);
    assert.deepEqual(callbackListener.paths, []);
    assert.equal(callbackListener.connectionCount(), 1);

    fs.writeFileSync(path.join(directory, 'owner-allowed'), 'yes');
    const delivered = await postCallback();
    assert.equal(delivered.status, 200);
    assert.equal((await delivered.json()).forwarded, true);
    assert.deepEqual(callbackListener.paths, ['/auth/callback?code=review-secret&state=review']);
    // One failed owner check and one successful callback produce exactly two
    // TCP connections. A second connection for the successful request would
    // reintroduce the listener-replacement race this path is designed to close.
    assert.equal(callbackListener.connectionCount(), 2);

    const fallbackDelivered = await postCallback(
        'http://localhost:1457/auth/callback?code=fallback-secret&state=fallback'
    );
    assert.equal(fallbackDelivered.status, 200);
    assert.equal((await fallbackDelivered.json()).forwarded, true);
    assert.deepEqual(fallbackListener.paths, [
        '/auth/callback?code=fallback-secret&state=fallback'
    ]);
    assert.equal(fallbackListener.connectionCount(), 1);

    const ownerChecks = fs.readFileSync(path.join(directory, 'owner-check'), 'utf8');
    assert.match(ownerChecks, /^4243 1455$/m);
    assert.match(ownerChecks, /^4243 1457$/m);
});

test('TCP loopback cannot dispatch shell commands while the private Unix socket can', async (t) => {
    const { baseUrl, shellDispatchSocket } = await startServer(t, false);
    const response = await fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(response.status, 403);

    const forgedBrowser = await fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: {
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin',
            'X-Codex-Terminal-Request': '1',
            'Content-Type': 'application/json'
        },
        body: '{}'
    });
    assert.equal(forgedBrowser.status, 403);

    const internal = await unixJsonRequest(shellDispatchSocket, {});
    assert.equal(internal.status, 400);
    assert.equal(fs.statSync(shellDispatchSocket).mode & 0o777, 0o600);

    const unrelatedWrite = await fetch(`${baseUrl}/terminal-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ctrl-c' })
    });
    assert.equal(unrelatedWrite.status, 403);
});

test('shell dispatch preserves private Codex versus same-origin browser provenance', async (t) => {
    let bufferFile;
    const { baseUrl, shellDispatchSocket } = await startServer(t, false, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        bufferFile = path.join(directory, 'fake-tmux-buffer');
        fs.writeFileSync(path.join(binDirectory, 'tmux'), `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\\n' ;;
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\\n' ;;
            *) printf '0\\n' ;;
        esac
        ;;
    load-buffer) cat > "$FAKE_TMUX_BUFFER" ;;
    capture-pane)
        start=$(awk 'match($0, /__CTP_SHELL_START_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_BUFFER")
        end=$(awk 'match($0, /__CTP_SHELL_END_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_BUFFER")
        printf '%s\\ncomplete\\n%s:0\\n' "$start" "$end"
        ;;
esac
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            FAKE_TMUX_BUFFER: bufferFile
        };
    });

    const dispatch = (headers) => fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ha store reload' })
    });

    const loopbackResponse = await unixJsonRequest(shellDispatchSocket, { command: 'ha store reload' });
    assert.equal(loopbackResponse.status, 200);
    assert.match(fs.readFileSync(bufferFile, 'utf8'), /CODEX_TERMINAL_AGENT_EXECUTION=1/);

    assert.equal((await dispatch({ Origin: baseUrl })).status, 403);

    const browserServer = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        bufferFile = path.join(directory, 'fake-tmux-buffer');
        fs.writeFileSync(path.join(binDirectory, 'tmux'), `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\\n' ;;
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\\n' ;;
            *) printf '0\\n' ;;
        esac
        ;;
    load-buffer) cat > "$FAKE_TMUX_BUFFER" ;;
    capture-pane)
        start=$(awk 'match($0, /__CTP_SHELL_START_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_BUFFER")
        end=$(awk 'match($0, /__CTP_SHELL_END_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_BUFFER")
        printf '%s\\ncomplete\\n%s:0\\n' "$start" "$end"
        ;;
esac
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            FAKE_TMUX_BUFFER: bufferFile
        };
    });
    const browserResponse = await fetch(`${browserServer.baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: { Origin: browserServer.baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ha store reload' })
    });
    assert.equal(browserResponse.status, 200);
    assert.doesNotMatch(fs.readFileSync(bufferFile, 'utf8'), /CODEX_TERMINAL_AGENT_EXECUTION=1/);
});

test('explicit loopback development mode still enforces same-origin upload checks', async (t) => {
    const { baseUrl, directory } = await startServer(t, true);
    const withoutOrigin = new FormData();
    withoutOrigin.set('image', new Blob([VALID_PNG], { type: 'image/png' }), 'first.png');
    assert.equal((await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        body: withoutOrigin
    })).status, 403);

    const foreignOrigin = new FormData();
    foreignOrigin.set('image', new Blob([VALID_PNG], { type: 'image/png' }), 'second.png');
    assert.equal((await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: {
            Origin: 'https://evil.example',
            'X-Codex-Terminal-Request': '1'
        },
        body: foreignOrigin
    })).status, 403);

    const filenames = [];
    for (let index = 0; index < 2; index += 1) {
        const form = new FormData();
        form.set('image', new Blob([VALID_PNG], { type: 'image/png' }), 'valid.png');
        const response = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            headers: { Origin: baseUrl },
            body: form
        });
        assert.equal(response.status, 200);
        filenames.push((await response.json()).filename);
    }

    // The browser wrapper adds only the request marker. In particular it must
    // leave Content-Type unset so fetch can supply the multipart boundary.
    const markerOnly = new FormData();
    markerOnly.set('image', new Blob([VALID_PNG], { type: 'image/png' }), 'marker.png');
    const markerResponse = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { 'X-Codex-Terminal-Request': '1' },
        body: markerOnly
    });
    assert.equal(markerResponse.status, 200);
    filenames.push((await markerResponse.json()).filename);

    assert.notEqual(filenames[0], filenames[1]);
    assert.equal(fs.readdirSync(path.join(directory, 'uploads')).length, 3);
});

test('every advertised portable image format passes a complete decode', async (t) => {
    const { baseUrl, directory } = await startServer(t, true);
    const makeRaster = (format) => sharp({
        create: {
            width: 2,
            height: 2,
            channels: 4,
            background: { r: 20, g: 40, b: 60, alpha: 1 }
        }
    })[format]().toBuffer();
    const samples = [
        ['sample.jpg', 'image/jpeg', await makeRaster('jpeg')],
        ['sample.png', 'image/png', await makeRaster('png')],
        ['sample.gif', 'image/gif', await makeRaster('gif')],
        ['sample.webp', 'image/webp', await makeRaster('webp')],
        [
            'sample.svg',
            'image/svg+xml',
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#123456"/></svg>')
        ]
    ];

    for (const [filename, mimetype, payload] of samples) {
        const form = new FormData();
        form.set('image', new Blob([payload], { type: mimetype }), filename);
        const response = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            headers: { Origin: baseUrl },
            body: form
        });
        assert.equal(response.status, 200, filename);
    }
    assert.equal(fs.readdirSync(path.join(directory, 'uploads')).length, samples.length);
});

test('an image signature without decodable pixels is rejected and removed', async (t) => {
    const { baseUrl, directory } = await startServer(t, true);
    const form = new FormData();
    form.set(
        'image',
        new Blob([Buffer.concat([MINIMAL_PNG_HEADER, Buffer.from('not-pixels')])], { type: 'image/png' }),
        'truncated.png'
    );
    const response = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { Origin: baseUrl },
        body: form
    });
    assert.equal(response.status, 400);
    assert.equal(fs.readdirSync(path.join(directory, 'uploads')).length, 0);
});

test('HEIC is rejected when the portable decoder cannot provide a complete decode', async (t) => {
    const { baseUrl, directory } = await startServer(t, true);
    const fakeHeic = Buffer.from('0000001866747970686569630000000068656963', 'hex');
    for (const [payload, filename] of [
        [fakeHeic, 'camera.heic'],
        [VALID_PNG, 'misleading.png']
    ]) {
        const form = new FormData();
        form.set('image', new Blob([payload], { type: 'image/heic' }), filename);
        const response = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            headers: { Origin: baseUrl },
            body: form
        });
        assert.equal(response.status, 400);
    }
    assert.equal(fs.readdirSync(path.join(directory, 'uploads')).length, 0);
});

test('SVG active content is rejected even when it appears after 4 KiB', async (t) => {
    const { baseUrl, directory } = await startServer(t, true);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${'a'.repeat(5000)}</desc><script>alert(1)</script></svg>`;
    const form = new FormData();
    form.set('image', new Blob([svg], { type: 'image/svg+xml' }), 'late-script.svg');
    const response = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { Origin: baseUrl },
        body: form
    });
    assert.equal(response.status, 400);
    assert.equal(fs.readdirSync(path.join(directory, 'uploads')).length, 0);
});

test('Change Desk accepts browser proof when Origin and Referer are absent', async (t) => {
    const { baseUrl } = await startServer(t, true);

    // Same-origin GET fetches carry no Origin header, and privacy tooling can
    // strip Referer entirely; the panel must still open.
    const bare = await fetch(`${baseUrl}/change-desk/summary`);
    assert.equal(bare.status, 403);
    assert.match((await bare.json()).error, /Cross-origin Change Desk access/);

    const markerOnly = await fetch(`${baseUrl}/change-desk/summary`, {
        headers: { 'X-Codex-Terminal-Request': '1' }
    });
    assert.equal(markerOnly.status, 200);
    assert.equal((await markerOnly.json()).success, true);

    const trusted = await fetch(`${baseUrl}/change-desk/report`, {
        method: 'POST',
        headers: {
            'Sec-Fetch-Site': 'same-origin',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ report: 'sec-fetch-site provenance check' })
    });
    assert.equal(trusted.status, 200);
    assert.equal((await trusted.json()).success, true);

    const crossSite = await fetch(`${baseUrl}/change-desk/report`, {
        method: 'POST',
        headers: {
            'Sec-Fetch-Site': 'cross-site',
            Origin: baseUrl,
            'X-Codex-Terminal-Request': '1',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ report: 'should be rejected' })
    });
    assert.equal(crossSite.status, 403);

    const hostileOrigin = await fetch(`${baseUrl}/change-desk/report`, {
        method: 'POST',
        headers: {
            Origin: 'https://evil.example',
            'X-Codex-Terminal-Request': '1',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ report: 'should also be rejected' })
    });
    assert.equal(hostileOrigin.status, 403);

    const hostilePreflight = await fetch(`${baseUrl}/change-desk/summary`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://evil.example',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-codex-terminal-request'
        }
    });
    assert.notEqual(hostilePreflight.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.doesNotMatch(hostilePreflight.headers.get('access-control-allow-headers') || '', /x-codex-terminal-request/i);

    // A proxy chain that rewrites Host still matches through X-Forwarded-Host.
    const forwardedHost = await fetch(`${baseUrl}/change-desk/report`, {
        method: 'POST',
        headers: {
            'X-Forwarded-Host': 'ha.example.com',
            'X-Forwarded-Proto': 'http',
            Referer: 'http://ha.example.com/api/hassio_ingress/token/',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ report: 'forwarded host provenance check' })
    });
    assert.equal(forwardedHost.status, 200);
});

test('Change Desk reports redact fine-grained GitHub tokens and JWTs', async (t) => {
    const { baseUrl } = await startServer(t, true);
    const githubToken = 'github_pat_abcdefghijklmnopqrstuvwxyz0123456789';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature_value';
    const report = [
        githubToken,
        `https://user:${githubToken}@github.com/owner/repo`,
        `GITHUB_TOKEN=${githubToken}`,
        jwt,
        '{"api_key":"TOPSECRET0123456789","password":"hunter2"}',
        'token: TOPSECRET0123456789',
        'TOKEN="TOPSECRET0123456789"',
        'mqtt://user:TOPSECRET0123456789@broker.local',
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
        'Authorization: Basic dXNlcjpTRVNSRVQ=',
        'Cookie: hass_session=COOKIE_SECRET_VALUE',
        'Set-Cookie: hass_session=SET_COOKIE_SECRET_VALUE; HttpOnly',
        '2026-07-15 ERROR response Set-Cookie: hass_session=PREFIXED_COOKIE_SECRET; HttpOnly',
        '{"Cookie":"hass_session=STRUCTURED_COOKIE_SECRET"}',
        'password: hello world',
        'private_key: |',
        '  BLOCK_SECRET_LINE_ONE',
        '  BLOCK_SECRET_LINE_TWO',
        '-----BEGIN PRIVATE KEY-----',
        'PEM_PRIVATE_SECRET_VALUE',
        '-----END PRIVATE KEY-----',
        '-----BEGIN ENCRYPTED PRIVATE KEY-----',
        'ENCRYPTED_PEM_SECRET_VALUE',
        '-----END ENCRYPTED PRIVATE KEY-----'
    ].join('\n');
    const response = await fetch(`${baseUrl}/change-desk/report`, {
        method: 'POST',
        headers: {
            Origin: baseUrl,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ report })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const persisted = fs.readFileSync(result.path, 'utf8');
    assert.doesNotMatch(persisted, /github_pat_/i);
    assert.doesNotMatch(persisted, /eyJhbGci/);
    assert.doesNotMatch(
        persisted,
        /TOPSECRET|hunter2|abcdefghijklmnopqrstuvwxyz|dXNlcjpTRVNSRVQ|hello world|COOKIE_SECRET|BLOCK_SECRET|PEM_PRIVATE|ENCRYPTED_PEM/
    );
    assert.doesNotMatch(persisted, /mqtt:\/\/user:/);
    assert.match(persisted, /\[redacted-github-token\]/);
    assert.match(persisted, /\[redacted-jwt\]/);
});

test('Change Desk parses audit JSON before redacting secret-shaped key names', async (t) => {
    const { baseUrl } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        fs.writeFileSync(path.join(binDirectory, 'ha-toolbox'), `#!/bin/sh
printf '%s\\n' '{"config":"/config","exists":true,"yaml":{"checked":1,"ok":1,"errors":[]},"counts":{},"custom_components":[],"expected_paths":{},"root_keys":{"api_key":2}}'
`, { mode: 0o755 });
        fs.writeFileSync(path.join(binDirectory, 'ha-api'), `#!/bin/sh
printf '%s\\n' '{"location_name":"Lab","version":"2026.7","time_zone":"America/Chicago","unit_system":{"name":"metric"},"components":[],"api_key":2}'
`, { mode: 0o755 });
        fs.writeFileSync(path.join(binDirectory, 'ha-mcp-status'), `#!/bin/sh
printf '%s\\n' '{"component_loaded":true,"internal_endpoint":"http://127.0.0.1","external_path":"/api/mcp","api_key":2}'
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS: '1000',
            CHANGE_DESK_COMMAND_TIMEOUT_MS: '1000'
        };
    });

    const response = await fetch(`${baseUrl}/change-desk/summary`, {
        headers: { Origin: baseUrl }
    });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.audit.available, true);
    assert.equal(summary.audit.rootKeys.api_key, 2);
    assert.equal(summary.live.available, true, JSON.stringify(summary.live));
    assert.equal(summary.live.config.locationName, 'Lab');
    assert.equal(summary.mcp.available, true, JSON.stringify(summary.mcp));
    assert.equal(summary.mcp.componentLoaded, true);
});

test('unsupported uploads and malformed or oversized JSON are client errors', async (t) => {
    const { baseUrl } = await startServer(t, true);

    const unsupported = new FormData();
    unsupported.set('image', new Blob(['not-avif'], { type: 'image/avif' }), 'image.avif');
    const unsupportedResponse = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { Origin: baseUrl },
        body: unsupported
    });
    assert.equal(unsupportedResponse.status, 400);
    assert.match((await unsupportedResponse.json()).error, /supported image/i);

    const malformed = await fetch(`${baseUrl}/terminal-control`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: '{'
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /valid JSON/i);

    const oversized = await fetch(`${baseUrl}/terminal-control`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'x'.repeat(600 * 1024) })
    });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /too large/i);
});

function writeMallCopFixtures(directory) {
    fs.writeFileSync(path.join(directory, 'monitor.json'), JSON.stringify({
        generated_at: new Date().toISOString(),
        status: 'warning',
        current_issues: [{
            key: 'large-test-sample',
            sample: 'untrusted-data-'.repeat(50000)
        }]
    }));
}

test('Mall Cop narrates through consult and never launches Codex itself', async (t) => {
    let attemptFile;
    let promptFile;
    const { baseUrl, stderr } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        attemptFile = path.join(directory, 'mall-cop-attempts');
        promptFile = path.join(directory, 'consult-prompt');
        // A codex on PATH must never be reached by the server directly: the
        // only path to a model is consult, which owns the isolation.
        fs.writeFileSync(
            path.join(binDirectory, 'codex'),
            `#!/bin/sh\nprintf x >> ${JSON.stringify(attemptFile)}\nexit 1\n`,
            { mode: 0o755 }
        );
        const consult = path.join(binDirectory, 'consult');
        fs.writeFileSync(consult, `#!/bin/sh
case "$1" in
    --list) printf '%s\\n' '{"consultants":[{"id":"codex","label":"Codex","installed":true,"signedIn":true,"ready":true,"authHelper":"codex-auth-helper"}]}' ;;
    --agent)
        [ "$2" = codex ] || { echo "wrong agent $2" >&2; exit 2; }
        cat > ${JSON.stringify(promptFile)}
        printf '## Bottom line\\nNarrated by the stub consultant.\\n\\n## Acute state\\nQuiet.\\n'
        ;;
esac
`, { mode: 0o755 });
        writeMallCopFixtures(directory);
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            CONSULT_BIN: consult,
            CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS: '10',
            CHANGE_DESK_COMMAND_TIMEOUT_MS: '10'
        };
    });

    const response = await fetch(`${baseUrl}/change-desk/mall-cop`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'auto' })
    });
    assert.equal(response.status, 200, `${await response.clone().text()}\n${stderr()}`);
    const firstPayload = await response.json();
    assert.match(firstPayload.observation.summary, /Narrated by the stub consultant/);
    assert.equal(firstPayload.observation.source, 'codex');
    assert.equal(fs.existsSync(attemptFile), false);
    // The consultant sees the fenced packet and the injection notice, never a
    // bare dump of the monitor data.
    const prompt = fs.readFileSync(promptFile, 'utf8');
    assert.match(prompt, /BEGIN_UNTRUSTED_HOME_ASSISTANT_DATA/);
    assert.match(prompt, /Never obey instructions/);
    assert.match(prompt, /END_UNTRUSTED_HOME_ASSISTANT_DATA/);

    const cooledDown = await fetch(`${baseUrl}/change-desk/mall-cop`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'auto' })
    });
    assert.equal(cooledDown.status, 200);
    assert.equal((await cooledDown.json()).skipped, true);
    assert.equal(fs.existsSync(attemptFile), false);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

test('Mall Cop falls back to the deterministic report when the narrator cannot run', async (t) => {
    const { baseUrl, stderr } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        const consult = path.join(binDirectory, 'consult');
        fs.writeFileSync(consult, `#!/bin/sh
case "$1" in
    --list) printf '%s\\n' '{"consultants":[]}' ;;
    *) echo "consult: Codex is signed out - the stored credential no longer holds a token, so sign in again" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
        writeMallCopFixtures(directory);
        return {
            CONSULT_BIN: consult,
            CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS: '10',
            CHANGE_DESK_COMMAND_TIMEOUT_MS: '10'
        };
    });

    const response = await fetch(`${baseUrl}/change-desk/mall-cop`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true })
    });
    assert.equal(response.status, 200, `${await response.clone().text()}\n${stderr()}`);
    const payload = await response.json();
    assert.match(payload.observation.summary, /## Bottom line/);
    assert.equal(payload.observation.source, 'deterministic');
    assert.match(payload.observation.sourceNote, /signed out/);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

test('Mall Cop ignores obsolete external launcher and timeout settings', async (t) => {
    let launcherPidFile;
    let descendantPidFile;
    const { baseUrl, stderr } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        launcherPidFile = path.join(directory, 'mall-cop-launcher-pid');
        descendantPidFile = path.join(directory, 'mall-cop-descendant-pid');
        fs.writeFileSync(
            path.join(binDirectory, 'codex'),
            `#!/bin/sh
descendant=''
trap 'wait "$descendant" 2>/dev/null || true; exit 0' TERM
(
    trap 'exit 0' TERM
    while :; do sleep 1; done
) &
descendant=$!
printf '%s\n' "$$" > ${JSON.stringify(launcherPidFile)}
printf '%s\n' "$descendant" > ${JSON.stringify(descendantPidFile)}
wait "$descendant"
`,
            { mode: 0o755 }
        );
        return {
            IMAGE_SERVICE_TEST_CODEX_PATH: path.join(binDirectory, 'codex'),
            CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS: '10',
            CHANGE_DESK_COMMAND_TIMEOUT_MS: '10',
            CHANGE_DESK_MALL_COP_TIMEOUT_MS: '1000'
        };
    });

    const response = await fetch(`${baseUrl}/change-desk/mall-cop`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true })
    });
    assert.equal(response.status, 200, `${await response.clone().text()}\n${stderr()}`);
    assert.equal(fs.existsSync(launcherPidFile), false);
    assert.equal(fs.existsSync(descendantPidFile), false);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

test('timed-out shell work is hard-stopped before the request completes', async (t) => {
    let stateFile;
    let newWindowArgsFile;
    let respawnArgsFile;
    const { baseUrl } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        stateFile = path.join(directory, 'fake-tmux-state');
        newWindowArgsFile = path.join(directory, 'fake-tmux-new-window-args');
        respawnArgsFile = path.join(directory, 'fake-tmux-respawn-args');
        const windowStateFile = path.join(directory, 'fake-tmux-window-state');
        const fakeTmux = path.join(binDirectory, 'tmux');
        fs.writeFileSync(fakeTmux, `#!/bin/sh
case "$1" in
    list-windows)
        if [ -f "$FAKE_TMUX_WINDOW_STATE" ]; then printf 'raw-shell\\n'; fi
        ;;
    new-window)
        printf '%s\\n' "$@" > "$FAKE_TMUX_NEW_WINDOW_ARGS"
        : > "$FAKE_TMUX_WINDOW_STATE"
        ;;
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\\n' ;;
            *) printf '0\\n' ;;
        esac
        ;;
    load-buffer) cat > "$FAKE_TMUX_STATE" ;;
    capture-pane)
        marker=$(awk 'match($0, /__CTP_SHELL_START_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_STATE")
        if [ -n "$marker" ]; then printf '%s\\nstill running\\n' "$marker"; fi
        ;;
    respawn-pane)
        printf '%s\\n' "$@" > "$FAKE_TMUX_RESPAWN_ARGS"
        printf '\\nrespawned\\n' >> "$FAKE_TMUX_STATE"
        ;;
esac
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            FAKE_TMUX_NEW_WINDOW_ARGS: newWindowArgsFile,
            FAKE_TMUX_RESPAWN_ARGS: respawnArgsFile,
            FAKE_TMUX_STATE: stateFile,
            FAKE_TMUX_WINDOW_STATE: windowStateFile,
            RAW_SHELL_COMMAND_TIMEOUT_MS: '0',
            RAW_SHELL_TERMINATION_GRACE_MS: '0'
        };
    });

    const response = await fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: {
            Origin: baseUrl,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command: 'sleep 999' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.timedOut, true);
    assert.equal(result.terminated, true);
    assert.match(fs.readFileSync(stateFile, 'utf8'), /respawned/);

    const readArgs = (file) => fs.readFileSync(file, 'utf8').trim().split('\n');
    const expectedLaunch =
        'env -u CODEX_TERMINAL_AGENT_EXECUTION CODEX_TERMINAL_HUMAN_SHELL=1 /bin/bash -l';
    assert.deepEqual(readArgs(newWindowArgsFile), [
        'new-window', '-d',
        '-t', 'codex-terminal',
        '-n', 'raw-shell',
        '-c', '/config',
        expectedLaunch
    ]);
    assert.deepEqual(readArgs(respawnArgsFile), [
        'respawn-pane', '-k',
        '-t', 'codex-terminal:raw-shell.0',
        '-c', '/config',
        expectedLaunch
    ]);
    for (const file of [newWindowArgsFile, respawnArgsFile]) {
        const launch = readArgs(file).at(-1);
        assert.match(launch, /\bCODEX_TERMINAL_HUMAN_SHELL=1\b/);
        assert.match(launch, /\benv -u CODEX_TERMINAL_AGENT_EXECUTION\b/);
        assert.doesNotMatch(launch, /\bCODEX_TERMINAL_AGENT_EXECUTION=1\b/);
    }
});

test('an interrupt failure still hard-respawns before releasing the shell queue', async (t) => {
    let stateFile;
    const { baseUrl } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        stateFile = path.join(directory, 'fake-tmux-state');
        const fakeTmux = path.join(binDirectory, 'tmux');
        fs.writeFileSync(fakeTmux, `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\\n' ;;
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\\n' ;;
            *) printf '0\\n' ;;
        esac
        ;;
    load-buffer) cat > "$FAKE_TMUX_STATE" ;;
    capture-pane)
        marker=$(awk 'match($0, /__CTP_SHELL_START_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_STATE")
        if [ -n "$marker" ]; then printf '%s\\npartial output\\n' "$marker"; fi
        ;;
    send-keys)
        case "$*" in *C-c*) exit 1 ;; esac
        ;;
    respawn-pane) printf '\\nrespawned-after-interrupt-error\\n' >> "$FAKE_TMUX_STATE" ;;
esac
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            FAKE_TMUX_STATE: stateFile,
            RAW_SHELL_COMMAND_TIMEOUT_MS: '0',
            RAW_SHELL_TERMINATION_GRACE_MS: '0'
        };
    });

    const response = await fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: {
            Origin: baseUrl,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command: 'sleep 999' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.timedOut, true);
    assert.equal(result.terminated, true);
    assert.match(fs.readFileSync(stateFile, 'utf8'), /respawned-after-interrupt-error/);
});

test('a capture failure resets the pane before the next queued command runs', async (t) => {
    let eventLog;
    const { baseUrl } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        const bufferFile = path.join(directory, 'fake-tmux-buffer');
        const captureCount = path.join(directory, 'fake-tmux-captures');
        eventLog = path.join(directory, 'fake-tmux-events');
        const fakeTmux = path.join(binDirectory, 'tmux');
        fs.writeFileSync(fakeTmux, `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\\n' ;;
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\\n' ;;
            *) printf '0\\n' ;;
        esac
        ;;
    load-buffer)
        cat > "$FAKE_TMUX_BUFFER"
        printf 'load\\n' >> "$FAKE_TMUX_EVENTS"
        ;;
    paste-buffer) printf 'paste\\n' >> "$FAKE_TMUX_EVENTS" ;;
    send-keys)
        case "$*" in *Enter*) printf 'enter\\n' >> "$FAKE_TMUX_EVENTS" ;; esac
        ;;
    capture-pane)
        count=0
        if [ -f "$FAKE_TMUX_CAPTURES" ]; then count=$(cat "$FAKE_TMUX_CAPTURES"); fi
        count=$((count + 1))
        printf '%s\\n' "$count" > "$FAKE_TMUX_CAPTURES"
        if [ "$count" -eq 1 ]; then
            printf 'capture-failed\\n' >> "$FAKE_TMUX_EVENTS"
            exit 1
        fi
        start=$(awk 'match($0, /__CTP_SHELL_START_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_BUFFER")
        end=$(awk 'match($0, /__CTP_SHELL_END_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_BUFFER")
        printf '%s\\nsecond command\\n%s:0\\n' "$start" "$end"
        ;;
    respawn-pane) printf 'respawn\\n' >> "$FAKE_TMUX_EVENTS" ;;
esac
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            FAKE_TMUX_BUFFER: bufferFile,
            FAKE_TMUX_CAPTURES: captureCount,
            FAKE_TMUX_EVENTS: eventLog
        };
    });

    const request = (command) => fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
    });
    const [first, second] = await Promise.all([request('first-command'), request('second-command')]);

    assert.equal(first.status, 502);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).output, 'second command');
    const events = fs.readFileSync(eventLog, 'utf8').trim().split('\n');
    assert.equal(events.filter((event) => event === 'load').length, 2);
    assert.ok(events.indexOf('respawn') > events.indexOf('capture-failed'));
    assert.ok(events.indexOf('respawn') < events.lastIndexOf('load'));
});

test('an end marker without a visible start marker completes as truncated output', async (t) => {
    let eventLog;
    const { baseUrl } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        const bufferFile = path.join(directory, 'fake-tmux-buffer');
        eventLog = path.join(directory, 'fake-tmux-events');
        fs.writeFileSync(path.join(binDirectory, 'tmux'), `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\\n' ;;
    display-message)
        case "$*" in
            *pane_current_command*) printf 'bash 4242\\n' ;;
            *) printf '0\\n' ;;
        esac
        ;;
    load-buffer) cat > "$FAKE_TMUX_BUFFER" ;;
    capture-pane)
        end=$(awk 'match($0, /__CTP_SHELL_END_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_BUFFER")
        printf 'stale-prompt-before-current-command-'
        printf '%0200d' 0
        printf '\\ncurrent-command-tail\\n%s:7\\n' "$end"
        ;;
    respawn-pane) printf 'respawn\\n' >> "$FAKE_TMUX_EVENTS" ;;
esac
`, { mode: 0o755 });
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            FAKE_TMUX_BUFFER: bufferFile,
            FAKE_TMUX_EVENTS: eventLog,
            RAW_SHELL_OUTPUT_MAX_CHARS: '80'
        };
    });

    const response = await fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'seq 1 5000' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.exitCode, 7);
    assert.equal(result.mode, 'codex');
    assert.equal(result.truncated, true);
    assert.match(result.output, /^\.\.\.\[earlier output truncated\]\n/);
    assert.match(result.output, /current-command-tail/);
    assert.doesNotMatch(result.output, /stale-prompt/);
    assert.equal(fs.existsSync(eventLog), false);
});
