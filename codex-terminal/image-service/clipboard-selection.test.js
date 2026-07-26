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

test('the OSC 52 parser swallows unarmed packets and stages only armed interactions', () => {
    let handler = null;
    const stagedCopies = [];
    const context = loadFunctions([
        'createTerminalClipboardState',
        'armTerminalClipboardInteraction',
        'consumeArmedOsc52',
        'decodeOsc52ClipboardData',
        'installOsc52ClipboardBridge'
    ], {
        stageCopyForNextGesture: (...args) => stagedCopies.push(args),
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
    assert.equal(stagedCopies.length, 0);
    assert.equal(handler('c;not base64'), true);

    context.armTerminalClipboardInteraction(state, 'pointer', Date.now());
    assert.equal(handler(packet), true);
    assert.equal(stagedCopies.length, 1);
    assert.equal(stagedCopies[0][0], 'trusted text');
    assert.equal(stagedCopies[0][1], 'osc52');
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

test('copy failures stage the selected text and are never reported as success', () => {
    const statuses = [];
    const stagedCopies = [];
    const context = loadFunctions(['updateTerminalSelectionCopyStatus'], {
        setStatus: (...args) => statuses.push(args),
        stageCopyForNextGesture: (...args) => stagedCopies.push(args)
    });

    context.updateTerminalSelectionCopyStatus(false, '  keep whitespace  ');
    assert.equal(stagedCopies.length, 1);
    assert.equal(stagedCopies[0][0], '  keep whitespace  ');
    assert.equal(statuses.length, 0);

    stagedCopies.length = 0;
    context.updateTerminalSelectionCopyStatus(true, 'copied');
    assert.equal(stagedCopies.length, 0);
    assert.deepEqual(statuses[0], ['Copied terminal selection', 'success', false]);
});

test('staged copies complete on the next trusted gesture and clear the stage', async () => {
    const statuses = [];
    const gestureCopies = [];
    const context = loadFunctions([
        'stageCopyForNextGesture',
        'stagedCopyGestureAllowed',
        'completeStagedCopyFromGesture'
    ], {
        setStatus: (...args) => statuses.push(args),
        showManualCopy: () => {},
        status: { style: {}, onclick: null },
        manualCopyPanel: null,
        stagedCopy: null,
        STAGED_COPY_TTL_MS: 60000,
        copyToClipboardFromGesture: (text, doc) => {
            gestureCopies.push([text, doc]);
            return true;
        }
    });

    context.stageCopyForNextGesture('staged text', 'selection');
    assert.equal(statuses.at(-1)[2], true);

    const gestureDocument = {};
    context.completeStagedCopyFromGesture({ type: 'mousedown', isTrusted: true }, gestureDocument);
    await Promise.resolve();
    assert.deepEqual(gestureCopies, [['staged text', gestureDocument]]);
    assert.deepEqual(statuses.at(-1), ['Copied terminal selection', 'success', false]);

    // The stage is cleared; a second gesture must not copy again.
    context.completeStagedCopyFromGesture({ type: 'mousedown', isTrusted: true }, gestureDocument);
    await Promise.resolve();
    assert.equal(gestureCopies.length, 1);
});

test('a failed staged completion keeps the text staged for the next gesture', async () => {
    const gestureCopies = [];
    const context = loadFunctions([
        'stageCopyForNextGesture',
        'stagedCopyGestureAllowed',
        'completeStagedCopyFromGesture'
    ], {
        setStatus: () => {},
        showManualCopy: () => {},
        status: { style: {}, onclick: null },
        manualCopyPanel: null,
        stagedCopy: null,
        STAGED_COPY_TTL_MS: 60000,
        copyToClipboardFromGesture: (text) => {
            gestureCopies.push(text);
            return false;
        }
    });

    context.stageCopyForNextGesture('sticky text', 'selection');
    context.completeStagedCopyFromGesture({ type: 'mousedown', isTrusted: true }, {});
    await Promise.resolve();
    context.completeStagedCopyFromGesture({ type: 'mousedown', isTrusted: true }, {});
    await Promise.resolve();
    assert.deepEqual(gestureCopies, ['sticky text', 'sticky text']);
});

test('staged completion ignores untrusted events, shortcut chords, and expired stages', () => {
    const gestureCopies = [];
    let now = 1000;
    const context = loadFunctions([
        'stageCopyForNextGesture',
        'stagedCopyGestureAllowed',
        'completeStagedCopyFromGesture'
    ], {
        setStatus: () => {},
        showManualCopy: () => {},
        status: { style: {}, onclick: null },
        manualCopyPanel: null,
        stagedCopy: null,
        STAGED_COPY_TTL_MS: 60000,
        Date: { now: () => now },
        copyToClipboardFromGesture: (text) => {
            gestureCopies.push(text);
            return true;
        }
    });

    context.stageCopyForNextGesture('guarded text', 'selection');
    context.completeStagedCopyFromGesture({ type: 'mousedown', isTrusted: false }, {});
    context.completeStagedCopyFromGesture({ type: 'keydown', isTrusted: true, key: 'Meta' }, {});
    context.completeStagedCopyFromGesture({ type: 'keydown', isTrusted: true, key: 'c', metaKey: true }, {});
    assert.equal(gestureCopies.length, 0);

    now += 60001;
    context.completeStagedCopyFromGesture({ type: 'mousedown', isTrusted: true }, {});
    assert.equal(gestureCopies.length, 0);

    // Expiry cleared the stage entirely.
    now += 1;
    context.completeStagedCopyFromGesture({ type: 'mousedown', isTrusted: true }, {});
    assert.equal(gestureCopies.length, 0);
});

test('gesture copy starts Clipboard API before the synchronous Safari fallback', async () => {
    const attempts = [];
    const context = loadFunctions([
        'clipboardWritePolicyAllows',
        'copyToClipboardFromGesture'
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

    assert.equal(await context.copyToClipboardFromGesture('text', {}), true);
    assert.deepEqual(attempts, ['clipboard', 'fallback']);
});

test('Clipboard API is attempted immediately when the synchronous fallback is unavailable', async () => {
    let clipboardAttempts = 0;
    const context = loadFunctions([
        'clipboardWritePolicyAllows',
        'copyToClipboardFromGesture'
    ], {
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

test('gesture copy prefers the gesture frame clipboard and retries through the top frame', async () => {
    const attempts = [];
    const context = loadFunctions([
        'clipboardWritePolicyAllows',
        'copyToClipboardFromGesture'
    ], {
        navigator: {
            clipboard: {
                writeText: async () => {
                    attempts.push('parent');
                }
            }
        },
        document: {},
        fallbackCopyToClipboard: () => false
    });
    const clipboardDocument = {
        defaultView: {
            navigator: {
                clipboard: {
                    writeText: async () => {
                        attempts.push('terminal-frame');
                        throw new Error('subframe clipboard denied');
                    }
                }
            }
        }
    };

    // The terminal frame's write is attempted first; when it is denied and the
    // synchronous fallback also fails, the top-level navigator is the rescue.
    assert.equal(await context.copyToClipboardFromGesture('text', clipboardDocument), true);
    assert.deepEqual(attempts, ['terminal-frame', 'parent']);
});

test('the top-frame clipboard is not retried after a successful synchronous fallback', async () => {
    const attempts = [];
    const context = loadFunctions([
        'clipboardWritePolicyAllows',
        'copyToClipboardFromGesture'
    ], {
        navigator: {
            clipboard: {
                writeText: async () => {
                    attempts.push('parent');
                }
            }
        },
        document: {},
        fallbackCopyToClipboard: () => {
            attempts.push('fallback');
            return true;
        }
    });
    const clipboardDocument = {
        defaultView: {
            navigator: {
                clipboard: {
                    writeText: async () => {
                        attempts.push('terminal-frame');
                        throw new Error('subframe clipboard denied');
                    }
                }
            }
        }
    };

    assert.equal(await context.copyToClipboardFromGesture('text', clipboardDocument), true);
    assert.deepEqual(attempts, ['terminal-frame', 'fallback']);
});

test('ingress policy denial preserves the gesture for synchronous native copy', async () => {
    const attempts = [];
    const context = loadFunctions([
        'clipboardWritePolicyAllows',
        'copyToClipboardFromGesture'
    ], {
        navigator: {
            clipboard: {
                writeText: async () => {
                    attempts.push('blocked-api');
                }
            }
        },
        document: {},
        fallbackCopyToClipboard: () => {
            attempts.push('native-copy');
            return true;
        }
    });
    const clipboardDocument = {
        featurePolicy: {
            allowsFeature: (feature) => feature !== 'clipboard-write'
        }
    };

    assert.equal(await context.copyToClipboardFromGesture('text', clipboardDocument), true);
    assert.deepEqual(attempts, ['native-copy']);
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
        'clipboardWritePolicyAllows',
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

test('native copy fallback writes exact text through the trusted copy event', () => {
    let copyListener = null;
    let copiedText = null;
    let prevented = false;
    const selection = {
        removeAllRanges() {},
        addRange() {}
    };
    const textArea = {
        style: {},
        focus() {},
        setSelectionRange() {},
        parentNode: null
    };
    const clipboardDocument = {
        body: {
            appendChild(node) {
                node.parentNode = this;
            },
            removeChild(node) {
                node.parentNode = null;
            }
        },
        createElement: () => textArea,
        getSelection: () => selection,
        createRange: () => ({ selectNodeContents() {} }),
        addEventListener(type, listener) {
            assert.equal(type, 'copy');
            copyListener = listener;
        },
        removeEventListener(type, listener) {
            assert.equal(type, 'copy');
            assert.equal(listener, copyListener);
            copyListener = null;
        },
        execCommand(command) {
            assert.equal(command, 'copy');
            copyListener({
                clipboardData: {
                    setData(type, value) {
                        assert.equal(type, 'text/plain');
                        copiedText = value;
                    }
                },
                preventDefault() {
                    prevented = true;
                }
            });
            return true;
        }
    };
    const context = loadFunctions(['fallbackCopyToClipboard']);

    assert.equal(context.fallbackCopyToClipboard('  界\n', clipboardDocument), true);
    assert.equal(copiedText, '  界\n');
    assert.equal(prevented, true);
    assert.equal(copyListener, null);
});

test('native copy fallback rejects execCommand false-success without clipboard data', () => {
    let copyListener = null;
    const textArea = {
        style: {},
        focus() {},
        setSelectionRange() {},
        parentNode: null
    };
    const clipboardDocument = {
        body: {
            appendChild(node) {
                node.parentNode = this;
            },
            removeChild(node) {
                node.parentNode = null;
            }
        },
        createElement: () => textArea,
        getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        createRange: () => ({ selectNodeContents() {} }),
        addEventListener(type, listener) {
            copyListener = listener;
        },
        removeEventListener() {
            copyListener = null;
        },
        execCommand() {
            copyListener({ clipboardData: null, preventDefault() {} });
            return true;
        }
    };
    const context = loadFunctions(['fallbackCopyToClipboard']);

    assert.equal(context.fallbackCopyToClipboard('text', clipboardDocument), false);
    assert.equal(copyListener, null);
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
