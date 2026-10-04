'use strict';

// Drives the Codex/Shell toggle with real mouse input after using the
// terminal: a drag selection, typing, a wheel scroll, plain focus, and a
// drag held past Chrome's 5 s activation window. Each scenario gets exactly
// ONE click on the toggle and must switch modes, in the page and in tmux,
// then ONE click back, including a copy staged for the next gesture, which
// the toggle click itself completes. First it checks that the toggle never
// moves when the status text changes, on a wide and a phone-width header.
// TOGGLE_E2E_VERBOSE=1 prints where every press and click landed.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');

const ORIGIN = 'http://127.0.0.1:7680';
const SESSION = process.env.TMUX_SESSION || 'codex-terminal';
const TMUX_SOCKET = process.env.TMUX_E2E_SOCKET || 'ctp-e2e';
const SWITCH_TIMEOUT_MS = 5000;
const POLL_TIMEOUT_MS = 1000;
// TOGGLE_E2E_VERBOSE=1 prints the press/release/click log for passing clicks too.
const VERBOSE = process.env.TOGGLE_E2E_VERBOSE === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Bounded: send-keys into a pane in copy mode can block on a jump prompt.
const tmux = (...args) => execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { timeout: 5000 }).toString().trim();

const WINDOWS = {
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36'
};

async function openPage(browser, viewport = { width: 1300, height: 900 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ platform, userAgent }) => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform });
        Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => userAgent });
        // While the top page sets __denyClipboard, every clipboard write in
        // every frame fails, which makes the page stage the copy for the next
        // gesture (the staged-copy scenario).
        const denied = () => {
            try {
                return Boolean(window.top.__denyClipboard);
            } catch {
                return false;
            }
        };
        const writeText = Clipboard.prototype.writeText;
        Clipboard.prototype.writeText = function (...args) {
            return denied()
                ? Promise.reject(new DOMException('Denied by test', 'NotAllowedError'))
                : writeText.apply(this, args);
        };
        const execCommand = Document.prototype.execCommand;
        Document.prototype.execCommand = function (...args) {
            return denied() && String(args[0]).toLowerCase() === 'copy' ? false : execCommand.apply(this, args);
        };
        // Record where each press, release and click on the top page landed,
        // and where the toggle buttons were at that moment, so a lost click
        // explains itself.
        if (window.top !== window) {
            return;
        }
        window.__toggleLog = [];
        const describe = (node) => {
            if (!(node instanceof Element)) {
                return String(node && node.nodeName);
            }
            const mode = node.getAttribute('data-terminal-mode');
            return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${mode ? `[${mode}]` : ''}`;
        };
        const record = (event) => {
            const buttons = Array.from(document.querySelectorAll('button[data-terminal-mode]')).map((button) => {
                const rect = button.getBoundingClientRect();
                return `${button.getAttribute('data-terminal-mode')}@${Math.round(rect.left)}-${Math.round(rect.right)}${button.disabled ? ':disabled' : ''}`;
            });
            window.__toggleLog.push({
                type: event.type,
                x: Math.round(event.clientX),
                y: Math.round(event.clientY),
                target: describe(event.target),
                buttons: buttons.join(' '),
                status: document.getElementById('status')?.textContent || ''
            });
        };
        for (const type of ['mousedown', 'mouseup', 'click']) {
            window.addEventListener(type, record, true);
        }
    }, WINDOWS);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => {
        const frame = document.querySelector('#terminal-frame');
        return Boolean(frame?.contentWindow?.term?.element);
    }, null, { timeout: 20000 });
    const frame = page.frames().find((candidate) => candidate.url().includes('/terminal'));
    return { context, page, frame };
}

async function serverMode() {
    const response = await fetch(`${ORIGIN}/terminal-mode`, {
        headers: { 'X-Codex-Terminal-Request': '1' },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
    });
    const body = await response.json();
    return body.mode;
}

async function setServerMode(mode) {
    const response = await fetch(`${ORIGIN}/terminal-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Codex-Terminal-Request': '1' },
        body: JSON.stringify({ mode })
    });
    if (!response.ok) {
        throw new Error(`setting terminal mode failed: ${response.status} ${await response.text()}`);
    }
}

function tmuxWindow() {
    return execFileSync('tmux', ['-L', TMUX_SOCKET, 'display', '-p', '-t', SESSION, '#{window_name}'], {
        timeout: POLL_TIMEOUT_MS
    }).toString().trim();
}

async function pageMode(page) {
    return page.evaluate(() => {
        const active = document.querySelector('button[data-terminal-mode][aria-pressed="true"]');
        return active ? active.getAttribute('data-terminal-mode') : null;
    });
}

async function terminalGeometry(page, frame, marker) {
    const geometry = await frame.evaluate((text) => {
        const term = window.term;
        const buffer = term.buffer.active;
        let row = -1;
        for (let y = 0; y < term.rows; y += 1) {
            if ((buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '').startsWith(text)) {
                row = y;
            }
        }
        const rect = term.element.querySelector('.xterm-screen').getBoundingClientRect();
        return { row, left: rect.left, top: rect.top, cellWidth: rect.width / term.cols, cellHeight: rect.height / term.rows };
    }, marker);
    const box = await page.locator('#terminal-frame').boundingBox();
    return {
        row: geometry.row,
        cell: (col, row) => ({
            x: box.x + geometry.left + col * geometry.cellWidth,
            y: box.y + geometry.top + (row + 0.5) * geometry.cellHeight
        })
    };
}

// What tmux and xterm show right now, so a marker that never appears
// explains itself.
async function terminalState(frame) {
    const query = (...args) => {
        try {
            return tmux(...args);
        } catch (err) {
            return `ERROR ${err.message.split('\n')[0]}`;
        }
    };
    const pane = query('display', '-p', '-t', `${SESSION}:0`,
        'mode=#{pane_in_mode}:#{pane_mode} scroll=#{scroll_position} size=#{pane_width}x#{pane_height} cmd=#{pane_current_command}');
    const windows = query('list-windows', '-t', SESSION, '-F', '#{window_index}:#{window_name}#{?window_active,*,}');
    const clients = query('list-clients', '-F', '#{client_name} #{client_width}x#{client_height} #{client_session}');
    const screen = query('capture-pane', '-p', '-t', `${SESSION}:0`).split('\n').filter(Boolean).slice(-4);
    let xterm;
    try {
        xterm = await frame.evaluate(() => {
            const term = window.term;
            const buffer = term.buffer.active;
            const lines = [];
            for (let y = 0; y < term.rows; y += 1) {
                const line = buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '';
                if (line.trim()) lines.push(line);
            }
            return `${term.cols}x${term.rows} ${buffer.type} viewportY=${buffer.viewportY} baseY=${buffer.baseY} lines=${JSON.stringify(lines.slice(0, 4))}`;
        });
    } catch (err) {
        xterm = `ERROR ${err.message.split('\n')[0]}`;
    }
    return `pane ${pane}; windows ${windows.replace(/\n/g, ' ')}; clients ${clients.replace(/\n/g, ' | ')}; tmux screen ${JSON.stringify(screen)}; xterm ${xterm}`;
}

// Leave copy mode (or any other mode) in window 0. In copy mode send-keys
// input is read as copy-mode commands, never reaching the shell: `t` and `f`
// open a jump prompt that blocks send-keys while a client is attached, and
// without one the keys fail.
function leavePaneMode() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (tmux('display', '-p', '-t', `${SESSION}:0`, '#{pane_in_mode}') !== '1') {
            return;
        }
        tmux('send-keys', '-t', `${SESSION}:0`, '-X', 'cancel');
    }
    throw new Error(`window 0 stays in ${tmux('display', '-p', '-t', `${SESSION}:0`, '#{pane_mode}')}`);
}

function attachedClients() {
    return tmux('list-clients', '-t', SESSION, '-F', '#{client_width}x#{client_height}').split('\n').filter(Boolean);
}

// The previous page's tmux client is gone (ttyd ends it when the WebSocket
// closes), so the next page's client is the only one.
async function waitForNoClients() {
    const deadline = Date.now() + 5000;
    while (attachedClients().length > 0) {
        if (Date.now() > deadline) {
            throw new Error(`tmux clients still attached: ${attachedClients().join(', ')}`);
        }
        await sleep(50);
    }
}

// Window 0 is the active window, and the page's own tmux client is the one
// client attached, at xterm's size: openPage only waits for xterm to exist,
// before ttyd's WebSocket has started a tmux client, which then attaches at a
// provisional size and resizes.
async function waitForTerminalReady(frame) {
    const deadline = Date.now() + 10000;
    let size = '';
    while (Date.now() < deadline) {
        size = await frame.evaluate(() => `${window.term.cols}x${window.term.rows}`);
        const active = tmux('display', '-p', '-t', `${SESSION}:0`, '#{window_active}') === '1';
        const clients = attachedClients();
        const windowSize = tmux('display', '-p', '-t', `${SESSION}:0`, '#{window_width}x#{window_height}');
        if (active && clients.length === 1 && clients[0] === size && windowSize === size) {
            return;
        }
        await sleep(50);
    }
    throw new Error(`terminal not ready for xterm ${size}; ${await terminalState(frame)}`);
}

// Print the marker in window 0 and wait until xterm shows it: first that the
// shell printed it, then that it is in xterm's viewport, scrolled to the end.
async function showMarker(page, frame) {
    leavePaneMode();
    tmux('send-keys', '-t', `${SESSION}:0`, "clear; printf 'TOGGLE_MARKER_LINE\\n'", 'Enter');
    const deadline = Date.now() + 5000;
    while (!tmux('capture-pane', '-p', '-t', `${SESSION}:0`).split('\n').includes('TOGGLE_MARKER_LINE')) {
        if (Date.now() > deadline) {
            throw new Error(`the shell never printed the marker; ${await terminalState(frame)}`);
        }
        await sleep(50);
    }
    await frame.evaluate(() => window.term.scrollToBottom());
    try {
        await frame.waitForFunction(() => {
            const buffer = window.term.buffer.active;
            for (let y = 0; y < window.term.rows; y += 1) {
                if ((buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '').startsWith('TOGGLE_MARKER_LINE')) {
                    return true;
                }
            }
            return false;
        }, null, { timeout: 10000 });
    } catch (err) {
        throw new Error(`${err.message.split('\n')[0]} waiting for the marker; ${await terminalState(frame)}`);
    }
    return terminalGeometry(page, frame, 'TOGGLE_MARKER_LINE');
}

async function dragSelect(page, frame, stepDelayMs) {
    const geometry = await showMarker(page, frame);
    const start = geometry.cell(0.3, geometry.row);
    const end = geometry.cell(12.3, geometry.row);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
        await page.mouse.move(start.x + ((end.x - start.x) * step) / 10, start.y);
        await sleep(stepDelayMs);
    }
    await page.mouse.up();
    await sleep(800);
}

const SCENARIOS = {
    // A quick drag that copies straight away.
    select: async (page, frame) => {
        await dragSelect(page, frame, 30);
    },
    // Click into the terminal, then type a command.
    type: async (page, frame) => {
        const geometry = await showMarker(page, frame);
        const point = geometry.cell(30, geometry.row + 2);
        await page.mouse.click(point.x, point.y);
        await page.keyboard.type('echo TYPED_INTO_TERMINAL', { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(500);
    },
    // Wheel up over the terminal (tmux enters copy mode).
    wheel: async (page) => {
        tmux('send-keys', '-t', `${SESSION}:0`, 'clear; seq 1 200', 'Enter');
        await sleep(400);
        const box = await page.locator('#terminal-frame').boundingBox();
        await page.mouse.move(box.x + 200, box.y + 150);
        for (let i = 0; i < 3; i += 1) {
            await page.mouse.wheel(0, -300);
            await sleep(100);
        }
        await sleep(400);
    },
    // Focus only: xterm's textarea has focus, no gesture at all.
    focused: async (page, frame) => {
        await frame.evaluate(() => window.term.focus());
        await sleep(200);
    },
    // A careful drag that outlasts Chrome's ~5 s transient activation.
    // Chromium still copies at mouseup here (nothing is staged).
    'slow-select': async (page, frame) => {
        await dragSelect(page, frame, 600);
    },
    // A drag whose copy cannot run at mouseup, so the page stages it
    // ("Selection ready ...") and finishes it on the next gesture: the
    // mousedown of the toggle click itself. Finishing the copy rewrites
    // #status between mousedown and mouseup; if that moved the button, the
    // mouseup and click would land on the header and the click would be
    // lost. Chromium never stages on its own here, so it needs the injected
    // clipboard failure above.
    'staged-copy': async (page, frame) => {
        await page.evaluate(() => {
            window.__denyClipboard = true;
        });
        await dragSelect(page, frame, 30);
        await page.evaluate(() => {
            window.__denyClipboard = false;
        });
        const status = await page.locator('#status').textContent();
        if (!/Selection ready/.test(status || '')) {
            throw new Error(`copy was not staged; status ${JSON.stringify(status)}`);
        }
    }
};

async function waitForMode(page, expected) {
    const deadline = Date.now() + SWITCH_TIMEOUT_MS;
    let state = {};
    while (Date.now() < deadline) {
        try {
            state = { page: await pageMode(page), server: await serverMode(), tmux: tmuxWindow() };
        } catch (err) {
            if (err.name !== 'TimeoutError' && err.code !== 'ETIMEDOUT') {
                throw err;
            }
            await sleep(100);
            continue;
        }
        const tmuxOk = expected === 'raw' ? state.tmux === 'raw-shell' : state.tmux !== 'raw-shell';
        if (state.page === expected && state.server === expected && tmuxOk) {
            return { ok: true, state };
        }
        await sleep(100);
    }
    return { ok: false, state };
}

// Exactly one real mouse click at the button's centre, with a human-length
// press, then a bounded wait for the page and the server to agree.
async function clickToggle(page, mode) {
    const box = await page.locator(`button[data-terminal-mode="${mode}"]`).boundingBox();
    await page.evaluate(() => {
        window.__toggleLog.length = 0;
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 });
    const result = await waitForMode(page, mode);
    const log = await page.evaluate(() => window.__toggleLog);
    return { ...result, log };
}

// Status messages from short to longer than any real one: the longest are a
// copyable upload path or a server error, both unbounded.
const STATUS_TEXTS = [
    '',
    'Copied terminal selection',
    'Selection ready — click or press a key to finish copying',
    `📋 /config/www/codex-uploads/${'an-unusually-long-uploaded-image-name-'.repeat(8)}.png (click to copy)`
];

// The toggle's position must not depend on the status text: identical
// button boxes for every message, nothing pushed off-screen, and a long
// message truncated rather than overlapping the toggle or the buttons.
async function checkHeaderLayout(browser, viewport) {
    const { context, page } = await openPage(browser, viewport);
    const lines = [];
    let ok = true;
    try {
        let reference = null;
        for (const text of STATUS_TEXTS) {
            const layout = await page.evaluate((message) => {
                window.setStatus(message, message ? 'success' : '', true);
                const box = (node) => {
                    const rect = node.getBoundingClientRect();
                    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
                };
                const status = document.getElementById('status');
                const controls = Array.from(document.querySelectorAll('#terminal-mode-switch, #header-actions .header-btn'))
                    .filter((node) => node.getBoundingClientRect().width > 0)
                    .map((node) => ({ id: node.id, ...box(node) }));
                return {
                    buttons: Array.from(document.querySelectorAll('button[data-terminal-mode]'))
                        .map((button) => ({ mode: button.getAttribute('data-terminal-mode'), ...box(button) })),
                    status: box(status),
                    statusTruncated: status.scrollWidth > status.clientWidth,
                    controls,
                    pageWidth: document.documentElement.scrollWidth
                };
            }, text);
            const label = `${viewport.width}px status ${text ? `${text.length} chars` : 'empty'}`;
            const problems = [];
            const buttons = JSON.stringify(layout.buttons);
            if (reference === null) {
                reference = buttons;
            } else if (buttons !== reference) {
                problems.push(`toggle moved: ${buttons} vs empty-status ${reference}`);
            }
            if (layout.pageWidth > viewport.width) {
                problems.push(`page is ${layout.pageWidth}px wide`);
            }
            for (const control of layout.controls) {
                if (control.left < 0 || control.right > viewport.width) {
                    problems.push(`#${control.id} off-screen at ${control.left}-${control.right}`);
                }
                const overlaps = layout.status.width > 0
                    && layout.status.left < control.right && control.left < layout.status.right
                    && layout.status.top < control.bottom && control.top < layout.status.bottom;
                if (overlaps) {
                    problems.push(`#status overlaps #${control.id}`);
                }
            }
            if (text.length > 200 && !layout.statusTruncated) {
                problems.push('long status is not truncated');
            }
            ok = ok && problems.length === 0;
            const where = layout.buttons.map((b) => `${b.mode}@${b.left}-${b.right},${b.top}`).join(' ');
            lines.push(`${problems.length ? 'FAIL' : 'ok  '} layout ${label}: ${where}${problems.length ? `; ${problems.join('; ')}` : ''}`);
        }
    } catch (err) {
        ok = false;
        lines.push(`FAIL layout ${viewport.width}px: ${err.message}`);
    } finally {
        await context.close();
    }
    return { ok, lines };
}

async function runScenario(browser, name) {
    // Start from Codex mode at a bash prompt in window 0, whatever the
    // previous test left behind: copy mode, or a foreground program. Two
    // C-c because a stray ^V (LNEXT) makes the tty take the first literally.
    try {
        await setServerMode('codex');
        leavePaneMode();
        tmux('send-keys', '-t', `${SESSION}:0`, 'C-c');
        tmux('send-keys', '-t', `${SESSION}:0`, 'C-c');
        await sleep(200);
        await waitForNoClients();
    } catch (err) {
        return { ok: false, lines: [`FAIL ${name}: reset: ${err.message}`] };
    }
    const { context, page, frame } = await openPage(browser);
    const lines = [];
    let ok = true;
    try {
        // This page's terminal shows window 0, out of any mode, at the bottom.
        await waitForTerminalReady(frame);
        leavePaneMode();
        await frame.evaluate(() => window.term.scrollToBottom());
        const start = await pageMode(page);
        const other = start === 'raw' ? 'codex' : 'raw';
        await SCENARIOS[name](page, frame);
        for (const target of [other, start]) {
            const result = await clickToggle(page, target);
            ok = ok && result.ok;
            lines.push(`${result.ok ? 'ok  ' : 'FAIL'} ${name}: one click to ${target} -> page=${result.state.page} server=${result.state.server} tmux=${result.state.tmux}`);
            if (!result.ok || VERBOSE) {
                for (const entry of result.log) {
                    lines.push(`       ${entry.type} (${entry.x},${entry.y}) on ${entry.target}; buttons ${entry.buttons}; status ${JSON.stringify(entry.status)}`);
                }
            }
            if (!result.ok) {
                break;
            }
        }
    } catch (err) {
        ok = false;
        lines.push(`FAIL ${name}: ${err.message}`);
    } finally {
        await context.close();
    }
    return { ok, lines };
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined });
    const failures = [];
    try {
        for (const viewport of [{ width: 1300, height: 900 }, { width: 390, height: 844 }]) {
            const { ok, lines } = await checkHeaderLayout(browser, viewport);
            console.log(lines.join('\n'));
            if (!ok) failures.push(`layout-${viewport.width}`);
        }
        for (const name of Object.keys(SCENARIOS)) {
            const { ok, lines } = await runScenario(browser, name);
            console.log(lines.join('\n'));
            if (!ok) failures.push(name);
        }
    } finally {
        await browser.close();
    }
    if (failures.length > 0) {
        console.error(`terminal toggle e2e failed: ${failures.join(', ')}`);
        process.exit(1);
    }
})();
