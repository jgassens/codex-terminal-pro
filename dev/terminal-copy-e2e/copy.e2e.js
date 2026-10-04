'use strict';

// Drives the real web UI: drag across known terminal text and check what
// lands on the clipboard, on an Apple and a non-Apple platform, for one and
// two lines; the copy must equal xterm's highlight. tmux must never enter
// copy mode from the drag, Ctrl+V on Windows must paste text and upload a
// pasted image once, and the mouse wheel must still scroll tmux history.
// Each test leaves tmux out of copy mode, so the next one starts at the shell.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');

const ORIGIN = 'http://127.0.0.1:7680';
const SESSION = process.env.TMUX_SESSION || 'codex-terminal';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TMUX_SOCKET = process.env.TMUX_E2E_SOCKET || 'ctp-e2e';
// Bounded: send-keys into a pane in copy mode can block on a jump prompt.
const tmux = (...args) => execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { timeout: 5000 }).toString().trim();

// Take the pane out of copy mode, so the next test starts at the shell; a
// wheel scroll leaves it there. Returns whether the pane is out of any mode.
function leaveCopyMode() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (tmux('display', '-p', '-t', SESSION, '#{pane_in_mode}') !== '1') {
            return true;
        }
        tmux('send-keys', '-t', SESSION, '-X', 'cancel');
    }
    return tmux('display', '-p', '-t', SESSION, '#{pane_in_mode}') !== '1';
}

const PLATFORMS = {
    mac: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' },
    windows: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' }
};

async function openPage(browser, platform) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    if (platform) {
        await context.addInitScript(({ platform: value, userAgent }) => {
            Object.defineProperty(Navigator.prototype, 'platform', { get: () => value });
            Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => userAgent });
        }, PLATFORMS[platform]);
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => {
        const frame = document.querySelector('#terminal-frame');
        return Boolean(frame?.contentWindow?.term?.element);
    }, null, { timeout: 20000 });
    return { context, page };
}

async function dragCopy(browser, platform, lines) {
    tmux('send-keys', '-t', SESSION, "clear; printf 'ALPHA_ONE_LINE\\nBRAVO_TWO_LINE\\n'", 'Enter');
    await sleep(500);
    const { context, page } = await openPage(browser, platform);
    try {
        await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
        const frame = page.frames().find((candidate) => candidate.url().includes('/terminal'));
        await frame.waitForFunction(() => {
            const buffer = window.term.buffer.active;
            for (let y = 0; y < window.term.rows; y += 1) {
                if ((buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '').startsWith('ALPHA_ONE_LINE')) {
                    return true;
                }
            }
            return false;
        }, null, { timeout: 10000 });
        const geometry = await frame.evaluate(() => {
            const term = window.term;
            const buffer = term.buffer.active;
            let row = -1;
            for (let y = 0; y < term.rows; y += 1) {
                if ((buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '').startsWith('ALPHA_ONE_LINE')) {
                    row = y;
                }
            }
            const rect = term.element.querySelector('.xterm-screen').getBoundingClientRect();
            return { row, left: rect.left, top: rect.top, cellWidth: rect.width / term.cols, cellHeight: rect.height / term.rows };
        });
        const box = await page.locator('#terminal-frame').boundingBox();
        const x0 = box.x + geometry.left + 0.3 * geometry.cellWidth;
        const y0 = box.y + geometry.top + (geometry.row + 0.5) * geometry.cellHeight;
        // 13.3 cells: xterm rounds a selection end at the half cell while a
        // floor-based rebuild would take one character more.
        const x1 = box.x + geometry.left + 13.3 * geometry.cellWidth;
        const y1 = y0 + (lines - 1) * geometry.cellHeight;

        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let step = 1; step <= 10; step += 1) {
            await page.mouse.move(x0 + ((x1 - x0) * step) / 10, y0 + ((y1 - y0) * step) / 10);
            await sleep(30);
        }
        const tmuxTookDrag = tmux('display', '-p', '-t', SESSION, '#{pane_in_mode}') === '1';
        await page.mouse.up();
        await sleep(800);
        const clipboard = await page.evaluate(() => navigator.clipboard.readText());
        const highlighted = await frame.evaluate(() => window.term.getSelection());
        return { clipboard, highlighted, tmuxTookDrag };
    } finally {
        leaveCopyMode();
        await context.close();
    }
}

async function windowsCtrlVPastes(browser) {
    tmux('send-keys', '-t', SESSION, 'clear; cat -v', 'Enter');
    await sleep(400);
    const { context, page } = await openPage(browser, 'windows');
    const uploads = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/upload') {
            uploads.push(request.url());
        }
    });
    try {
        const box = await page.locator('#terminal-frame').boundingBox();
        await page.mouse.click(box.x + 300, box.y + 200);
        await page.evaluate(() => navigator.clipboard.writeText('PASTED_TEXT_OK'));
        await page.keyboard.press('Control+V');
        await sleep(800);
        const textPasted = tmux('capture-pane', '-p', '-t', SESSION).includes('PASTED_TEXT_OK');

        await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 8;
            canvas.height = 8;
            canvas.getContext('2d').fillRect(0, 0, 8, 8);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        });
        await page.keyboard.press('Control+V');
        await sleep(1500);
        return { textPasted, imageUploads: uploads.length };
    } finally {
        tmux('send-keys', '-t', SESSION, 'C-c');
        await context.close();
    }
}

async function wheelScrolls(browser) {
    tmux('send-keys', '-t', SESSION, 'clear; seq 1 200', 'Enter');
    await sleep(500);
    const { context, page } = await openPage(browser);
    try {
        const box = await page.locator('#terminal-frame').boundingBox();
        await page.mouse.move(box.x + 200, box.y + 150);
        for (let i = 0; i < 5; i += 1) {
            await page.mouse.wheel(0, -300);
            await sleep(100);
        }
        await sleep(400);
        const scrolled = tmux('display', '-p', '-t', SESSION, '#{pane_in_mode}') === '1';
        return { scrolled, left: leaveCopyMode() };
    } finally {
        await context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined });
    const failures = [];
    try {
        for (const platform of ['mac', 'windows']) {
            for (const lines of [1, 2]) {
                // Releasing at 13.3 cells highlights 13 characters; a rebuild from
                // the pointer cell would copy 14. xterm joins lines with CRLF on
                // Windows.
                const newline = platform === 'windows' ? '\r\n' : '\n';
                const expected = lines === 1 ? 'ALPHA_ONE_LIN' : `ALPHA_ONE_LINE${newline}BRAVO_TWO_LIN`;
                let result;
                try {
                    result = await dragCopy(browser, platform, lines);
                } catch (err) {
                    result = { clipboard: `ERROR ${err.message}`, highlighted: null, tmuxTookDrag: null };
                }
                const ok = result.clipboard === expected &&
                    result.clipboard === result.highlighted &&
                    result.tmuxTookDrag === false;
                console.log(`${ok ? 'ok  ' : 'FAIL'} ${platform}, ${lines} line(s): clipboard=${JSON.stringify(result.clipboard)} highlighted=${JSON.stringify(result.highlighted)} tmuxTookDrag=${result.tmuxTookDrag}`);
                if (!ok) failures.push(`${platform}/${lines}`);
            }
        }
        const paste = await windowsCtrlVPastes(browser);
        const pasteOk = paste.textPasted && paste.imageUploads === 1;
        console.log(`${pasteOk ? 'ok  ' : 'FAIL'} Windows Ctrl+V: text pasted=${paste.textPasted}, image uploads=${paste.imageUploads}`);
        if (!pasteOk) failures.push('windows-paste');

        const { scrolled, left } = await wheelScrolls(browser);
        console.log(`${scrolled ? 'ok  ' : 'FAIL'} mouse wheel scrolls tmux history`);
        if (!scrolled) failures.push('wheel');
        console.log(`${left ? 'ok  ' : 'FAIL'} tmux leaves copy mode after the wheel test`);
        if (!left) failures.push('wheel-leave');
    } finally {
        await browser.close();
    }
    if (failures.length > 0) {
        console.error(`terminal copy e2e failed: ${failures.join(', ')}`);
        process.exit(1);
    }
})();
