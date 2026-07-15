'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseJsonLinesTail, writeFileAtomic } = require('./persistence-utils');

test('atomic write replaces the complete file with private permissions', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctp-atomic-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'memory.json');
    fs.writeFileSync(filePath, 'old');

    writeFileAtomic(filePath, '{"complete":true}\n', { mode: 0o600 });

    assert.equal(fs.readFileSync(filePath, 'utf8'), '{"complete":true}\n');
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory), ['memory.json']);
});

test('JSONL tail parsing keeps valid neighbors around a malformed line', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctp-jsonl-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'history.jsonl');
    fs.writeFileSync(filePath, [
        '{"sample":1}',
        'not-json',
        '{"sample":2}',
        '',
        '{"sample":3}'
    ].join('\n'));

    assert.deepEqual(parseJsonLinesTail(filePath, { limit: 10, maxBytes: 4096 }), [
        { sample: 1 },
        { sample: 2 },
        { sample: 3 }
    ]);
    assert.deepEqual(parseJsonLinesTail(filePath, { limit: 1, maxBytes: 4096 }), [
        { sample: 3 }
    ]);

    fs.appendFileSync(filePath, '\nmalformed-tail');
    assert.deepEqual(parseJsonLinesTail(filePath, { limit: 2, maxBytes: 4096 }), [
        { sample: 2 },
        { sample: 3 }
    ]);
});
