'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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

async function startServer(t, allowLoopbackDevelopment, buildExtraEnvironment = () => ({})) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctp-server-test-'));
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
    } catch (err) {
        throw new Error(`${err.message}\n${stderr}`);
    }
    return { baseUrl, directory, child, stderr: () => stderr };
}

test('direct loopback access is denied by default while the local health probe remains available', async (t) => {
    const { baseUrl } = await startServer(t, false);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('referrer-policy'), 'strict-origin');
    assert.equal((await fetch(`${baseUrl}/config`)).status, 403);
});

test('the bundled loopback shell dispatcher is narrowly allowed without browser headers', async (t) => {
    const { baseUrl } = await startServer(t, false);
    const response = await fetch(`${baseUrl}/terminal-shell-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(response.status, 400);

    const unrelatedWrite = await fetch(`${baseUrl}/terminal-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ctrl-c' })
    });
    assert.equal(unrelatedWrite.status, 403);
});

test('explicit loopback development mode still enforces same-origin upload checks', async (t) => {
    const { baseUrl, directory } = await startServer(t, true);
    const withoutOrigin = new FormData();
    withoutOrigin.set('image', new Blob([MINIMAL_PNG_HEADER], { type: 'image/png' }), 'first.png');
    assert.equal((await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        body: withoutOrigin
    })).status, 403);

    const foreignOrigin = new FormData();
    foreignOrigin.set('image', new Blob([MINIMAL_PNG_HEADER], { type: 'image/png' }), 'second.png');
    assert.equal((await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
        body: foreignOrigin
    })).status, 403);

    const filenames = [];
    for (let index = 0; index < 2; index += 1) {
        const form = new FormData();
        form.set('image', new Blob([MINIMAL_PNG_HEADER], { type: 'image/png' }), 'valid.png');
        const response = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            headers: { Origin: baseUrl },
            body: form
        });
        assert.equal(response.status, 200);
        filenames.push((await response.json()).filename);
    }

    assert.notEqual(filenames[0], filenames[1]);
    assert.equal(fs.readdirSync(path.join(directory, 'uploads')).length, 2);
});

test('Change Desk accepts browser Sec-Fetch-Site proof when Origin and Referer are absent', async (t) => {
    const { baseUrl } = await startServer(t, true);

    // Same-origin GET fetches carry no Origin header, and privacy tooling can
    // strip Referer entirely; the panel must still open.
    const bare = await fetch(`${baseUrl}/change-desk/summary`);
    assert.equal(bare.status, 403);
    assert.match((await bare.json()).error, /Cross-origin Change Desk access/);

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
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ report: 'should be rejected' })
    });
    assert.equal(crossSite.status, 403);

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

test('an early Codex exit during Mall Cop input returns an error without crashing the service', async (t) => {
    let attemptFile;
    const { baseUrl, stderr } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        attemptFile = path.join(directory, 'mall-cop-attempts');
        fs.writeFileSync(
            path.join(binDirectory, 'codex'),
            `#!/bin/sh\nprintf x >> ${JSON.stringify(attemptFile)}\nexit 1\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(directory, 'monitor.json'), JSON.stringify({
            generated_at: new Date().toISOString(),
            status: 'warning',
            current_issues: [{
                key: 'large-test-sample',
                sample: 'untrusted-data-'.repeat(50000)
            }]
        }));
        return {
            PATH: `${binDirectory}:${process.env.PATH}`,
            IMAGE_SERVICE_TEST_CODEX_PATH: path.join(binDirectory, 'codex'),
            CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS: '10',
            CHANGE_DESK_COMMAND_TIMEOUT_MS: '10',
            CHANGE_DESK_MALL_COP_TIMEOUT_MS: '2000'
        };
    });

    const response = await fetch(`${baseUrl}/change-desk/mall-cop`, {
        method: 'POST',
        headers: {
            Origin: baseUrl,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ mode: 'auto' })
    });
    assert.equal(response.status, 502, `${await response.clone().text()}\n${stderr()}`);
    assert.equal(fs.readFileSync(attemptFile, 'utf8'), 'x');

    const cooledDown = await fetch(`${baseUrl}/change-desk/mall-cop`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'auto' })
    });
    assert.equal(cooledDown.status, 200);
    assert.equal((await cooledDown.json()).skipped, true);
    assert.equal(fs.readFileSync(attemptFile, 'utf8'), 'x');

    const manualRetry = await fetch(`${baseUrl}/change-desk/mall-cop`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true })
    });
    assert.equal(manualRetry.status, 502);
    assert.equal(fs.readFileSync(attemptFile, 'utf8'), 'xx');
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

test('timed-out shell work is hard-stopped before the request completes', async (t) => {
    let stateFile;
    const { baseUrl } = await startServer(t, true, (directory) => {
        const binDirectory = path.join(directory, 'bin');
        fs.mkdirSync(binDirectory);
        stateFile = path.join(directory, 'fake-tmux-state');
        const fakeTmux = path.join(binDirectory, 'tmux');
        fs.writeFileSync(fakeTmux, `#!/bin/sh
case "$1" in
    list-windows) printf 'raw-shell\\n' ;;
    display-message) printf '0\\n' ;;
    load-buffer) cat > "$FAKE_TMUX_STATE" ;;
    capture-pane)
        marker=$(awk 'match($0, /__CTP_SHELL_START_[A-Za-z0-9_]+__/) { print substr($0, RSTART, RLENGTH); exit }' "$FAKE_TMUX_STATE")
        if [ -n "$marker" ]; then printf '%s\\nstill running\\n' "$marker"; fi
        ;;
    respawn-pane) printf '\\nrespawned\\n' >> "$FAKE_TMUX_STATE" ;;
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
    assert.match(fs.readFileSync(stateFile, 'utf8'), /respawned/);
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
    display-message) printf '0\\n' ;;
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
    display-message) printf '0\\n' ;;
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
    display-message) printf '0\\n' ;;
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
