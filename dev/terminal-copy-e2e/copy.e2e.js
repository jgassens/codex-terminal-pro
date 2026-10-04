'use strict';

// Drives the real web UI: drag across known terminal text and check what
// lands on the clipboard, on an Apple and a non-Apple platform, for one and
// two lines. tmux must never enter copy mode from the drag, and the mouse
// wheel must still scroll tmux history.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');

const ORIGIN = 'http://127.0.0.1:7680';
const SESSION = process.env.TMUX_SESSION || 'codex-terminal';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmux = (...args) => execFileSync('tmux', args).toString().trim();

async function openPage(browser, platform) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    if (platform) {
        await context.addInitScript((value) => {
            Object.defineProperty(Navigator.prototype, 'platform', { get: () => value });
        }, platform);
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
        const x1 = box.x + geometry.left + 13.7 * geometry.cellWidth;
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
        return { clipboard, tmuxTookDrag };
    } finally {
        try {
            execFileSync('tmux', ['send-keys', '-t', SESSION, '-X', 'cancel'], { stdio: 'ignore' });
        } catch {
            // Not in copy mode, which is the expected state.
        }
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
        return tmux('display', '-p', '-t', SESSION, '#{pane_in_mode}') === '1';
    } finally {
        await context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined });
    const failures = [];
    try {
        for (const platform of ['MacIntel', 'Linux x86_64']) {
            for (const lines of [1, 2]) {
                const expected = lines === 1 ? 'ALPHA_ONE_LINE' : 'ALPHA_ONE_LINE\nBRAVO_TWO_LINE';
                let result;
                try {
                    result = await dragCopy(browser, platform, lines);
                } catch (err) {
                    result = { clipboard: `ERROR ${err.message}`, tmuxTookDrag: null };
                }
                const ok = result.clipboard === expected && result.tmuxTookDrag === false;
                console.log(`${ok ? 'ok  ' : 'FAIL'} ${platform}, ${lines} line(s): clipboard=${JSON.stringify(result.clipboard)} tmuxTookDrag=${result.tmuxTookDrag}`);
                if (!ok) failures.push(`${platform}/${lines}`);
            }
        }
        const scrolled = await wheelScrolls(browser);
        console.log(`${scrolled ? 'ok  ' : 'FAIL'} mouse wheel scrolls tmux history`);
        if (!scrolled) failures.push('wheel');
    } finally {
        await browser.close();
    }
    if (failures.length > 0) {
        console.error(`terminal copy e2e failed: ${failures.join(', ')}`);
        process.exit(1);
    }
})();
