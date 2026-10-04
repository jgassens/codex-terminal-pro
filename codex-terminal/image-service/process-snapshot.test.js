'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseProcessSnapshot, readProcessSnapshot } = require('./process-snapshot');

// Shaped like `ps -e -o pid=,ppid=,user:32=,args=` from Alpine's procps-ng
// 4.0.4: header-less, pid right-aligned, user padded to 32 columns.
const user32 = (name) => name.padEnd(32);
const procpsLine = (pid, ppid, user, args) => `${String(pid).padStart(7)} ${String(ppid).padStart(7)} ${user32(user)} ${args}`;

test('parses header-less procps-ng output into children, args and users', () => {
    const snapshot = parseProcessSnapshot([
        procpsLine(1, 0, 'root', '/sbin/init'),
        procpsLine(42, 1, 'root', 'tmux new-session'),
        procpsLine(4243, 42, 'ctp-claude', 'sleep 30')
    ].join('\n') + '\n');
    assert.deepEqual(snapshot.children.get(1), [42]);
    assert.deepEqual(snapshot.children.get(42), [4243]);
    assert.equal(snapshot.argsByPid.get(4243), 'sleep 30');
    assert.equal(snapshot.userByPid.get(42), 'root');
    assert.equal(snapshot.userByPid.get(4243), 'ctp-claude');
});

test('keeps spaces inside args and drops leading or trailing padding', () => {
    const snapshot = parseProcessSnapshot([
        procpsLine(10, 1, 'root', 'sh -c   echo  "a   b"   '),
        procpsLine(11, 1, 'root', '   /bin/bash -l'),
        '   12      1 root                             node server.js --flag "two words"'
    ].join('\n'));
    assert.equal(snapshot.argsByPid.get(10), 'sh -c   echo  "a   b"');
    assert.equal(snapshot.argsByPid.get(11), '/bin/bash -l');
    assert.equal(snapshot.argsByPid.get(12), 'node server.js --flag "two words"');
});

test('skips blank lines, headers and unparseable rows', () => {
    const snapshot = parseProcessSnapshot([
        '',
        '    PID    PPID USER     COMMAND',
        procpsLine(5, 1, 'root', 'init'),
        '   ',
        'garbage',
        '7 1 root',
        ''
    ].join('\n'));
    assert.deepEqual([...snapshot.argsByPid.keys()], [5]);
});

test('returns empty maps for empty output', () => {
    const snapshot = parseProcessSnapshot('');
    assert.equal(snapshot.children.size, 0);
    assert.equal(snapshot.argsByPid.size, 0);
    assert.equal(snapshot.userByPid.size, 0);
});

test('keeps a long user name whole when the column is wide', () => {
    const snapshot = parseProcessSnapshot(procpsLine(9, 1, 'ctp-claude', 'claude'));
    assert.equal(snapshot.userByPid.get(9), 'ctp-claude');
});

test('a user name truncated by procps-ng reports as empty so it never matches a trusted user', () => {
    // Default-width procps-ng prints ctp-claude and ctp-claudeX alike.
    const snapshot = parseProcessSnapshot([
        '   18       1 ctp-cla+ sleep 31',
        '   20       1 ctp-cla+ sleep 33'
    ].join('\n'));
    assert.equal(snapshot.userByPid.get(18), '');
    assert.equal(snapshot.userByPid.get(20), '');
    assert.notEqual(snapshot.userByPid.get(18), 'ctp-claude');
    assert.notEqual(snapshot.userByPid.get(18), 'ctp-cla+');
});

test('a name that fills the user column is ambiguous', () => {
    const full = 'u'.repeat(32);
    assert.equal(parseProcessSnapshot(`5 1 ${full} cmd`).userByPid.get(5), '');
    assert.equal(parseProcessSnapshot(`5 1 ${full.slice(1)} cmd`).userByPid.get(5), full.slice(1));
});

test('with the 8-column fallback format only names shorter than the column are trusted', () => {
    const snapshot = parseProcessSnapshot([
        '1 0 root /sbin/launchd',
        '2 1 jeremiah cmd',
        '3 1 ctp-cla+ cmd'
    ].join('\n'), { userColumnWidth: 8 });
    assert.equal(snapshot.userByPid.get(1), 'root');
    assert.equal(snapshot.userByPid.get(2), '');
    assert.equal(snapshot.userByPid.get(3), '');
});

test('numeric uids (accounts without a name) are kept as-is and are not user names', () => {
    const snapshot = parseProcessSnapshot(procpsLine(19, 1, '61004', 'sleep 32'));
    assert.equal(snapshot.userByPid.get(19), '61004');
});

function withFakePs(script, run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-snapshot-'));
    const originalPath = process.env.PATH;
    fs.writeFileSync(path.join(directory, 'ps'), script, { mode: 0o755 });
    process.env.PATH = `${directory}:${originalPath}`;
    const restore = () => {
        process.env.PATH = originalPath;
        fs.rmSync(directory, { recursive: true, force: true });
    };
    return new Promise((resolve, reject) => {
        run((err, value) => {
            restore();
            if (err) reject(err);
            else resolve(value);
        });
    });
}

test('readProcessSnapshot asks ps for a wide user column and parses the result', async () => {
    const snapshot = await withFakePs(`#!/bin/sh
case "$*" in
    '-e -o pid=,ppid=,user:32=,args=') printf '%s\\n' '    1       0 root                             /sbin/init' '   18       1 ctp-claude                       sleep 31' ;;
    *) exit 64 ;;
esac
`, (done) => readProcessSnapshot(done));
    assert.equal(snapshot.userByPid.get(18), 'ctp-claude');
    assert.equal(snapshot.argsByPid.get(1), '/sbin/init');
});

test('readProcessSnapshot falls back to plain user when ps rejects the width syntax', async () => {
    const snapshot = await withFakePs(`#!/bin/sh
case "$*" in
    '-e -o pid=,ppid=,user=,args=') printf '%s\\n' '1 0 root /sbin/launchd' '2 1 jeremiah cmd' ;;
    *) echo "ps: user:32: keyword not found" >&2; exit 1 ;;
esac
`, (done) => readProcessSnapshot(done));
    assert.equal(snapshot.userByPid.get(1), 'root');
    assert.equal(snapshot.userByPid.get(2), '');
});

test('readProcessSnapshot reports the error when every format fails', async () => {
    await assert.rejects(
        withFakePs('#!/bin/sh\nexit 2\n', (done) => readProcessSnapshot(done)),
        (err) => err.code === 2
    );
});
