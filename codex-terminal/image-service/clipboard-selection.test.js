'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { TextDecoder } = require('node:util');

const htmlPath = path.join(__dirname, 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function extractFunction(name) {
    const marker = `function ${name}(`;
    const start = html.indexOf(marker);
    assert.notStrictEqual(start, -1, `missing ${name}`);

    const openBrace = html.indexOf('{', start);
    assert.notStrictEqual(openBrace, -1, `missing body for ${name}`);

    let depth = 0;
    for (let index = openBrace; index < html.length; index += 1) {
        if (html[index] === '{') {
            depth += 1;
        } else if (html[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return html.slice(start, index + 1);
            }
        }
    }

    throw new Error(`unterminated function ${name}`);
}

function loadFunctions(names, additions = {}) {
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        Date,
        Math,
        Promise,
        TextDecoder,
        Uint8Array,
        atob,
        setTimeout,
        clearTimeout,
        OSC52_CLIPBOARD_ARM_MS: 2500,
        OSC52_MAX_BYTES: 256 * 1024,
        OSC52_MAX_ENCODED_LENGTH: Math.ceil((256 * 1024) / 3) * 4,
        ...additions
    });

    for (const name of names) {
        vm.runInContext(`${extractFunction(name)}\nthis.${name} = ${name};`, context);
    }
    return context;
}

test('one interaction permits one automatic attempt, while a new gesture may retry', () => {
    const context = loadFunctions([
        'createTerminalClipboardState',
        'armTerminalClipboardInteraction',
        'beginTerminalCopyAttempt'
    ]);
    const state = context.createTerminalClipboardState();

    const firstInteraction = context.armTerminalClipboardInteraction(state, 'pointer', 1000);
    assert.equal(context.beginTerminalCopyAttempt(state, firstInteraction, 'same text', 1001), true);
    assert.equal(context.beginTerminalCopyAttempt(state, firstInteraction, 'same text', 1002), false);

    const explicitNewGesture = context.armTerminalClipboardInteraction(state, 'pointer', 2000);
    assert.equal(context.beginTerminalCopyAttempt(state, explicitNewGesture, 'same text', 2001), true);
});

test('OSC 52 is accepted only while armed and never duplicates the direct attempt', () => {
    const context = loadFunctions([
        'createTerminalClipboardState',
        'armTerminalClipboardInteraction',
        'beginTerminalCopyAttempt',
        'consumeArmedOsc52'
    ]);

    const unarmed = context.createTerminalClipboardState();
    assert.equal(context.consumeArmedOsc52(unarmed, 'hello', 1000).accepted, false);

    const staged = context.createTerminalClipboardState();
    context.armTerminalClipboardInteraction(staged, 'pointer', 1000);
    assert.deepEqual(
        { ...context.consumeArmedOsc52(staged, 'hello', 1001) },
        { accepted: true, duplicate: false, interactionId: 1 }
    );

    const duplicate = context.createTerminalClipboardState();
    const duplicateId = context.armTerminalClipboardInteraction(duplicate, 'pointer', 1000);
    context.beginTerminalCopyAttempt(duplicate, duplicateId, 'hello', 1001);
    assert.deepEqual(
        { ...context.consumeArmedOsc52(duplicate, 'hello', 1002) },
        { accepted: true, duplicate: true, interactionId: duplicateId }
    );

    const mismatch = context.createTerminalClipboardState();
    const mismatchId = context.armTerminalClipboardInteraction(mismatch, 'pointer', 1000);
    context.beginTerminalCopyAttempt(mismatch, mismatchId, 'expected', 1001);
    assert.equal(context.consumeArmedOsc52(mismatch, 'injected', 1002).accepted, false);

    const expired = context.createTerminalClipboardState();
    context.armTerminalClipboardInteraction(expired, 'pointer', 1000);
    assert.equal(context.consumeArmedOsc52(expired, 'late', 3501).accepted, false);
});

test('the OSC 52 parser swallows unarmed packets and stages only a trusted gesture', () => {
    let handler = null;
    const manualCopies = [];
    const context = loadFunctions([
        'createTerminalClipboardState',
        'armTerminalClipboardInteraction',
        'consumeArmedOsc52',
        'decodeOsc52ClipboardData',
        'installOsc52ClipboardBridge'
    ], {
        showManualCopy: (...args) => manualCopies.push(args),
        setStatus: () => {}
    });
    const iframeWindow = {
        term: {
            parser: {
                registerOscHandler(code, callback) {
                    assert.equal(code, 52);
                    handler = callback;
                    return { dispose() {} };
                }
            }
        }
    };
    const state = context.createTerminalClipboardState();
    context.installOsc52ClipboardBridge(iframeWindow, state);

    const packet = `c;${Buffer.from('trusted text').toString('base64')}`;
    assert.equal(handler(packet), true);
    assert.equal(manualCopies.length, 0);
    assert.equal(handler('c;not base64'), true);

    context.armTerminalClipboardInteraction(state, 'pointer', Date.now());
    assert.equal(handler(packet), true);
    assert.equal(manualCopies.length, 1);
    assert.equal(manualCopies[0][0], 'trusted text');
});

test('OSC 52 decoding preserves Unicode and whitespace and enforces target and size limits', () => {
    const context = loadFunctions(['decodeOsc52ClipboardData']);
    const text = '  界 e\u0301\u00a0\n';
    const encoded = Buffer.from(text, 'utf8').toString('base64');

    assert.equal(context.decodeOsc52ClipboardData(`c;${encoded}`), text);
    assert.equal(context.decodeOsc52ClipboardData(`p;${encoded}`), '');
    assert.equal(context.decodeOsc52ClipboardData('c;not base64'), '');
    assert.equal(
        context.decodeOsc52ClipboardData(`c;${'A'.repeat(Math.ceil((256 * 1024) / 3) * 4 + 1)}`),
        ''
    );
});

test('terminal cell extraction keeps wide characters, combining marks, and exact spaces', () => {
    const context = loadFunctions(['terminalLineTextFromCells']);
    const cells = [
        ['A', 1],
        ['界', 2],
        ['', 0],
        ['e\u0301', 1],
        [' ', 1],
        ['\u00a0', 1]
    ].map(([chars, width]) => ({
        getChars: () => chars,
        getWidth: () => width
    }));
    const line = { getCell: (column) => cells[column] };

    assert.equal(context.terminalLineTextFromCells(line, 0, cells.length), 'A界e\u0301 \u00a0');
    assert.equal(context.terminalLineTextFromCells(line, 3, cells.length), 'e\u0301 \u00a0');
});

test('the canonical xterm selection is returned without trimming or Unicode rewriting', () => {
    const context = loadFunctions([
        'orderedTerminalCells',
        'terminalCellsDiffer',
        'selectTerminalRange',
        'getTerminalSelection',
        'terminalLineTextFromCells',
        'getTerminalTextFromDrag'
    ]);
    const selectedText = '  界 e\u0301\u00a0  ';
    const iframeWindow = {
        term: {
            cols: 12,
            select() {},
            getSelection: () => selectedText,
            buffer: {
                active: {
                    viewportY: 0,
                    getLine: () => ({ getCell: () => null })
                }
            }
        }
    };

    assert.equal(
        context.getTerminalTextFromDrag(
            iframeWindow,
            { row: 0, col: 0 },
            { row: 0, col: 8 }
        ),
        selectedText
    );
});

test('copy failures expose the selected text and are never reported as success', () => {
    const statuses = [];
    const manualCopies = [];
    const context = loadFunctions(['updateTerminalSelectionCopyStatus'], {
        setStatus: (...args) => statuses.push(args),
        showManualCopy: (...args) => manualCopies.push(args)
    });

    context.updateTerminalSelectionCopyStatus(false, '  keep whitespace  ');
    assert.equal(manualCopies.length, 1);
    assert.equal(manualCopies[0][0], '  keep whitespace  ');
    assert.deepEqual(statuses[0], ['Copy blocked — use Copy selection', 'error', true]);

    statuses.length = 0;
    manualCopies.length = 0;
    context.updateTerminalSelectionCopyStatus(true, 'copied');
    assert.equal(manualCopies.length, 0);
    assert.deepEqual(statuses[0], ['Copied terminal selection', 'success', false]);
});

test('gesture copy starts Clipboard API before the synchronous Safari fallback', async () => {
    const attempts = [];
    const context = loadFunctions(['copyToClipboardFromGesture'], {
        navigator: {
            clipboard: {
                writeText: async () => {
                    attempts.push('clipboard');
                }
            }
        },
        document: {},
        fallbackCopyToClipboard: () => {
            attempts.push('fallback');
            return true;
        }
    });

    assert.equal(await context.copyToClipboardFromGesture('text', {}), true);
    assert.deepEqual(attempts, ['clipboard', 'fallback']);
});

test('Clipboard API is attempted immediately when the synchronous fallback is unavailable', async () => {
    let clipboardAttempts = 0;
    const context = loadFunctions(['copyToClipboardFromGesture'], {
        navigator: {
            clipboard: {
                writeText: async () => {
                    clipboardAttempts += 1;
                    throw new Error('blocked');
                }
            }
        },
        document: {},
        fallbackCopyToClipboard: () => false
    });

    assert.equal(await context.copyToClipboardFromGesture('text', {}), false);
    assert.equal(clipboardAttempts, 1);
});

test('same-cell double/triple-click selection must be new, not stale', () => {
    const context = loadFunctions(['newSameCellTerminalSelection']);
    assert.equal(context.newSameCellTerminalSelection('', 'selected word'), 'selected word');
    assert.equal(context.newSameCellTerminalSelection('selected word', 'selected line'), 'selected line');
    assert.equal(context.newSameCellTerminalSelection('stale text', 'stale text'), '');
    assert.equal(context.newSameCellTerminalSelection('stale text', ''), '');
});

test('the explicit Copy control starts Clipboard API and keeps the synchronous fallback', async () => {
    const attempts = [];
    const context = loadFunctions([
        'copyToClipboardFromGesture',
        'copyToClipboardFromExplicitControl'
    ], {
        navigator: {
            clipboard: {
                writeText: async () => {
                    attempts.push('clipboard');
                }
            }
        },
        document: {},
        fallbackCopyToClipboard: () => {
            attempts.push('fallback');
            return true;
        }
    });

    assert.equal(await context.copyToClipboardFromExplicitControl('text', {}), true);
    assert.deepEqual(attempts, ['clipboard', 'fallback']);
});

test('terminal API initialization retries until ready and can be canceled', () => {
    const scheduled = [];
    const cleared = [];
    const context = loadFunctions(['waitForTerminalApi'], {
        setTimeout: (callback, delay) => {
            scheduled.push({ callback, delay });
            return scheduled.length;
        },
        clearTimeout: (timer) => cleared.push(timer)
    });

    const iframeWindow = { closed: false, term: null };
    let initialized = 0;
    const cancel = context.waitForTerminalApi(iframeWindow, () => {
        initialized += 1;
    });
    assert.equal(initialized, 0);
    assert.equal(scheduled.length, 1);

    iframeWindow.term = { getSelection: () => '' };
    scheduled.shift().callback();
    assert.equal(initialized, 1);

    const waitingWindow = { closed: false, term: null };
    const cancelWaiting = context.waitForTerminalApi(waitingWindow, () => {});
    const pending = scheduled.at(-1);
    cancelWaiting();
    pending.callback();
    assert.ok(cleared.length >= 1);
    cancel();
});

test('the UI keeps an explicit Copy button and has no stale-selection fallback', () => {
    assert.match(html, /id="manual-copy-button"[^>]*>Copy selection<\/button>/);
    assert.match(html, /manualCopyButton\.addEventListener\('click'/);
    assert.doesNotMatch(html, /lastKnownTerminalSelection|lastCopiedTerminalSelection/);
    assert.doesNotMatch(html, /addEventListener\('touchend',\s*copyTerminalSelection/);

    const dragFunction = extractFunction('getTerminalTextFromDrag');
    assert.doesNotMatch(dragFunction, /\.slice\(|\.trim\(/);

    const oscFunction = extractFunction('installOsc52ClipboardBridge');
    assert.doesNotMatch(oscFunction, /copyToClipboardFromGesture/);
    assert.match(oscFunction, /consumeArmedOsc52/);

    const statusFunction = extractFunction('setStatus');
    assert.match(statusFunction, /status\.onclick = null/);
    assert.match(statusFunction, /status\.style\.cursor = ''/);
    assert.doesNotMatch(html, /setTimeout\(\(\) => \{\s*setStatus\(originalText/);
});
