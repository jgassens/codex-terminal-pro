'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const {
    createTmuxPasteBufferName,
    loadTmuxPasteBuffer
} = require('./tmux-paste-buffer');

function fakeLoader() {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.stdinText = '';
    child.stdin = new Writable({
        write(chunk, encoding, done) {
            child.stdinText += chunk.toString();
            done();
        }
    });
    child.killedWith = [];
    child.kill = (signal) => {
        child.killedWith.push(signal);
        return true;
    };
    return child;
}

test('tmux paste buffer names remain unique within the same millisecond', () => {
    const first = createTmuxPasteBufferName();
    const second = createTmuxPasteBufferName();

    assert.notEqual(first, second);
    assert.match(first, /^codex-terminal-paste-\d+-\d+-[0-9a-f]{16}$/);
    assert.match(second, /^codex-terminal-paste-\d+-\d+-[0-9a-f]{16}$/);
});

test('both server paste paths use the bounded shared loader', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const sharedLoaderCalls = serverSource.match(/loadTmuxPasteBuffer\(text, \{\},/g) || [];

    assert.equal(sharedLoaderCalls.length, 2);
    assert.doesNotMatch(serverSource, /spawn\('tmux', \['load-buffer'/);
    assert.doesNotMatch(serverSource, /codex-terminal-paste-\$\{Date\.now\(\)\}/);
});

test('a successful tmux loader returns its unique buffer name exactly once', async () => {
    const child = fakeLoader();
    const calls = [];
    const result = new Promise((resolve) => {
        loadTmuxPasteBuffer('selected text', {
            bufferName: 'unique-buffer',
            timeoutMs: 100,
            spawnProcess(command, args, options) {
                assert.equal(command, 'tmux');
                assert.deepEqual(args, ['load-buffer', '-b', 'unique-buffer', '-']);
                assert.deepEqual(options.stdio, ['pipe', 'ignore', 'pipe']);
                return child;
            }
        }, (err, bufferName) => {
            calls.push({ err, bufferName });
            resolve();
        });
    });

    child.emit('close', 0);
    child.emit('close', 0);
    await result;

    assert.equal(child.stdinText, 'selected text');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].err, null);
    assert.equal(calls[0].bufferName, 'unique-buffer');
});

test('a hung tmux loader is killed and reports one bounded timeout', async () => {
    const child = fakeLoader();
    const calls = [];

    await new Promise((resolve) => {
        loadTmuxPasteBuffer('selected text', {
            bufferName: 'hung-buffer',
            timeoutMs: 5,
            spawnProcess: () => child
        }, (err, bufferName) => {
            calls.push({ err, bufferName });
            resolve();
        });
    });

    child.emit('close', null, 'SIGKILL');
    assert.deepEqual(child.killedWith, ['SIGKILL']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].err?.code, 'TMUX_LOAD_BUFFER_TIMEOUT');
    assert.equal(calls[0].bufferName, undefined);
});

test('tmux loader stderr becomes a once-only failure', async () => {
    const child = fakeLoader();
    const calls = [];
    const result = new Promise((resolve) => {
        loadTmuxPasteBuffer('selected text', {
            timeoutMs: 100,
            spawnProcess: () => child
        }, (err) => {
            calls.push(err);
            resolve();
        });
    });

    child.stderr.write('no tmux server');
    child.emit('close', 1);
    child.emit('error', new Error('late error'));
    await result;

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.code, 'TMUX_LOAD_BUFFER_FAILED');
    assert.equal(calls[0]?.message, 'no tmux server');
});
