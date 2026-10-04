'use strict';

// Drives the Codex/Shell toggle with real mouse input after using the
// terminal: a drag selection, typing, a wheel scroll, plain focus, and a
// drag held past Chrome's 5 s activation window. Each scenario gets exactly
// ONE click on the toggle and must switch modes, in the page and in tmux,
// then ONE click back. TOGGLE_E2E_STAGED=1 adds a scenario where the copy is
// staged for the next gesture; TOGGLE_E2E_VERBOSE=1 prints where every press
// and click landed.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');

const ORIGIN = 'http://127.0.0.1:7680';
const SESSION = process.env.TMUX_SESSION || 'codex-terminal';
const TMUX_SOCKET = process.env.TMUX_E2E_SOCKET || 'ctp-e2e';
const SWITCH_TIMEOUT_MS = 5000;
// TOGGLE_E2E_VERBOSE=1 prints the press/release/click log for passing clicks too.
const VERBOSE = process.env.TOGGLE_E2E_VERBOSE === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmux = (...args) => execFileSync('tmux', ['-L', TMUX_SOCKET, ...args]).toString().trim();

const WINDOWS = {
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36'
};

async function openPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
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
    const response = await fetch(`${ORIGIN}/terminal-mode`, { headers: { 'X-Codex-Terminal-Request': '1' } });
    const body = await response.json();
    return body.mode;
}

async function setServerMode(mode) {
    await fetch(`${ORIGIN}/terminal-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Codex-Terminal-Request': '1' },
        body: JSON.stringify({ mode })
    });
}

function tmuxWindow() {
    return tmux('display', '-p', '-t', SESSION, '#{window_name}');
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

async function showMarker(page, frame) {
    tmux('send-keys', '-t', `${SESSION}:0`, "clear; printf 'TOGGLE_MARKER_LINE\\n'", 'Enter');
    await frame.waitForFunction(() => {
        const buffer = window.term.buffer.active;
        for (let y = 0; y < window.term.rows; y += 1) {
            if ((buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '').startsWith('TOGGLE_MARKER_LINE')) {
                return true;
            }
        }
        return false;
    }, null, { timeout: 10000 });
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
    // mousedown of the toggle click itself. Opt-in (TOGGLE_E2E_STAGED=1): it
    // fails today because finishing the copy rewrites #status, the header
    // reflows, and the button moves out from under the pointer before
    // mouseup. Chromium never stages on its own here, so it needs the
    // injected clipboard failure above.
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
        state = { page: await pageMode(page), server: await serverMode(), tmux: tmuxWindow() };
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

async function runScenario(browser, name) {
    // Start from Codex mode at a bash prompt in window 0, whatever the
    // previous test left behind: copy mode, or a foreground program. Two
    // C-c because a stray ^V (LNEXT) makes the tty take the first literally.
    await setServerMode('codex');
    try {
        execFileSync('tmux', ['-L', TMUX_SOCKET, 'send-keys', '-t', `${SESSION}:0`, '-X', 'cancel'], { stdio: 'ignore' });
    } catch {
        // Not in copy mode.
    }
    tmux('send-keys', '-t', `${SESSION}:0`, 'C-c');
    tmux('send-keys', '-t', `${SESSION}:0`, 'C-c');
    await sleep(200);
    const { context, page, frame } = await openPage(browser);
    const lines = [];
    let ok = true;
    try {
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
        const names = Object.keys(SCENARIOS)
            .filter((name) => name !== 'staged-copy' || process.env.TOGGLE_E2E_STAGED === '1');
        for (const name of names) {
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
