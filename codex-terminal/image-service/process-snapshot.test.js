'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    PS_ARGS,
    isTrustedProcessUid,
    parseProcessSnapshot,
    readProcessSnapshot,
    resolveTrustedProcessUid
} = require('./process-snapshot');

// Shaped like `ps -ww -e -o pid=,ppid=,uid=,args=` from Alpine's procps-ng
// 4.0.4: header-less, pid and uid right-aligned. macOS ps prints the same
// columns with narrower padding.
const procpsLine = (pid, ppid, uid, args) => `${String(pid).padStart(7)} ${String(ppid).padStart(7)} ${String(uid).padStart(5)} ${args}`;

test('asks ps for every process, unlimited width, numeric uid', () => {
    assert.deepEqual(PS_ARGS, ['-ww', '-e', '-o', 'pid=,ppid=,uid=,args=']);
});

test('parses header-less procps-ng output into children, args and uids', () => {
    const snapshot = parseProcessSnapshot([
        procpsLine(1, 0, 0, '/sbin/init'),
        procpsLine(42, 1, 0, 'tmux new-session'),
        procpsLine(4243, 42, 61001, 'sleep 30')
    ].join('\n') + '\n');
    assert.deepEqual(snapshot.children.get(1), [42]);
    assert.deepEqual(snapshot.children.get(42), [4243]);
    assert.equal(snapshot.argsByPid.get(4243), 'sleep 30');
    assert.equal(snapshot.uidByPid.get(1), 0);
    assert.equal(snapshot.uidByPid.get(42), 0);
    assert.equal(snapshot.uidByPid.get(4243), 61001);
});

test('parses macOS ps output, where uids such as 501 are printed in full', () => {
    const snapshot = parseProcessSnapshot([
        '    1     0     0 /sbin/launchd',
        '  828     1   501 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
        '  900   828 4294967294 /usr/sbin/nobody-task'
    ].join('\n'));
    assert.equal(snapshot.uidByPid.get(828), 501);
    assert.equal(snapshot.uidByPid.get(900), 4294967294);
    assert.equal(snapshot.argsByPid.get(828), '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder');
});

test('keeps spaces inside args and drops leading or trailing padding', () => {
    const snapshot = parseProcessSnapshot([
        procpsLine(10, 1, 0, 'sh -c   echo  "a   b"   '),
        procpsLine(11, 1, 0, '   /bin/bash -l'),
        '   12      1     0 node server.js --flag "two words" 61001'
    ].join('\n'));
    assert.equal(snapshot.argsByPid.get(10), 'sh -c   echo  "a   b"');
    assert.equal(snapshot.argsByPid.get(11), '/bin/bash -l');
    assert.equal(snapshot.argsByPid.get(12), 'node server.js --flag "two words" 61001');
    assert.equal(snapshot.uidByPid.get(12), 0);
});

test('keeps long args whole, as -ww delivers them', () => {
    const longArgs = `/bin/bash /usr/local/bin/claude-auth-helper ${'--option '.repeat(500)}end`;
    const snapshot = parseProcessSnapshot(procpsLine(77, 1, 0, longArgs));
    assert.equal(snapshot.argsByPid.get(77), longArgs.trim());
    assert.match(snapshot.argsByPid.get(77), /claude-auth-helper .* end$/);
});

test('skips blank lines, headers and unparseable rows without leaving a uid', () => {
    const snapshot = parseProcessSnapshot([
        '',
        '    PID    PPID   UID COMMAND',
        procpsLine(5, 1, 0, 'init'),
        '   ',
        'garbage',
        '7 1 0',
        '8 1 root cmd',
        '9 1 ctp-cla+ cmd',
        '10 1 -1 cmd',
        '11 1 0x0 cmd',
        '12 x 0 cmd',
        ''
    ].join('\n'));
    assert.deepEqual([...snapshot.argsByPid.keys()], [5]);
    assert.deepEqual([...snapshot.uidByPid.keys()], [5]);
    for (const pid of [7, 8, 9, 10, 11, 12]) {
        assert.equal(snapshot.uidByPid.has(pid), false, `pid ${pid}`);
        assert.equal(isTrustedProcessUid(snapshot.uidByPid.get(pid), 0), false, `pid ${pid}`);
    }
});

test('returns empty maps for empty output', () => {
    const snapshot = parseProcessSnapshot('');
    assert.equal(snapshot.children.size, 0);
    assert.equal(snapshot.argsByPid.size, 0);
    assert.equal(snapshot.uidByPid.size, 0);
});

test('only the exact trusted uid is trusted', () => {
    assert.equal(isTrustedProcessUid(0, 0), true);
    assert.equal(isTrustedProcessUid(501, 501), true);
    assert.equal(isTrustedProcessUid(61001, 0), false);
    assert.equal(isTrustedProcessUid(1, 0), false);
    assert.equal(isTrustedProcessUid(10, 1), false);
    assert.equal(isTrustedProcessUid(undefined, 0), false);
    assert.equal(isTrustedProcessUid(null, 0), false);
    assert.equal(isTrustedProcessUid('0', 0), false);
    assert.equal(isTrustedProcessUid(NaN, 0), false);
    assert.equal(isTrustedProcessUid(0, null), false);
    assert.equal(isTrustedProcessUid(undefined, undefined), false);
    assert.equal(isTrustedProcessUid(null, null), false);
    assert.equal(isTrustedProcessUid(NaN, NaN), false);
});

test('the trusted uid defaults to this process uid', () => {
    assert.equal(resolveTrustedProcessUid({}, () => 0), 0);
    assert.equal(resolveTrustedProcessUid({}, () => 501), 501);
    assert.equal(resolveTrustedProcessUid({ SIGNIN_TRUSTED_PROCESS_UID: '' }, () => 501), 501);
    assert.equal(resolveTrustedProcessUid({}, null), null);
    assert.equal(resolveTrustedProcessUid({}, () => -1), null);
    assert.equal(resolveTrustedProcessUid({}), process.getuid());
});

test('SIGNIN_TRUSTED_PROCESS_UID accepts only a plain decimal uid and otherwise trusts nothing', () => {
    assert.equal(resolveTrustedProcessUid({ SIGNIN_TRUSTED_PROCESS_UID: '0' }, () => 501), 0);
    assert.equal(resolveTrustedProcessUid({ SIGNIN_TRUSTED_PROCESS_UID: '61001' }, () => 0), 61001);
    for (const bad of ['root', '-1', '0x0', '1.5', ' 0', '0 ', '1e3', '99999999999999999999']) {
        assert.equal(resolveTrustedProcessUid({ SIGNIN_TRUSTED_PROCESS_UID: bad }, () => 0), null, bad);
    }
});

test('the retired SIGNIN_TRUSTED_PROCESS_USER set on its own trusts nothing', () => {
    assert.equal(resolveTrustedProcessUid({ SIGNIN_TRUSTED_PROCESS_USER: 'root' }, () => 0), null);
    assert.equal(
        resolveTrustedProcessUid({ SIGNIN_TRUSTED_PROCESS_USER: 'root', SIGNIN_TRUSTED_PROCESS_UID: '0' }, () => 501),
        0
    );
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

test('readProcessSnapshot asks ps for wide args and numeric uids and parses the result', async () => {
    const snapshot = await withFakePs(`#!/bin/sh
case "$*" in
    '-ww -e -o pid=,ppid=,uid=,args=') printf '%s\\n' '    1       0     0 /sbin/init' '   18       1 61001 sleep 31' ;;
    *) echo "ps: unexpected arguments: $*" >&2; exit 64 ;;
esac
`, (done) => readProcessSnapshot(done));
    assert.equal(snapshot.uidByPid.get(1), 0);
    assert.equal(snapshot.uidByPid.get(18), 61001);
    assert.equal(snapshot.argsByPid.get(1), '/sbin/init');
});

test('readProcessSnapshot runs ps once and reports its error', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-calls-'));
    const log = path.join(directory, 'calls');
    try {
        await assert.rejects(
            withFakePs(`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 2\n`, (done) => readProcessSnapshot(done)),
            (err) => err.code === 2
        );
        assert.equal(fs.readFileSync(log, 'utf8'), '-ww -e -o pid=,ppid=,uid=,args=\n');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('readProcessSnapshot against the real ps finds this process under its own uid', async () => {
    const snapshot = await new Promise((resolve, reject) => {
        readProcessSnapshot((err, value) => (err ? reject(err) : resolve(value)));
    });
    assert.equal(snapshot.uidByPid.get(process.pid), process.getuid());
    assert.match(snapshot.argsByPid.get(process.pid) || '', /node/);
    assert.ok((snapshot.children.get(process.ppid) || []).includes(process.pid));
    assert.equal(isTrustedProcessUid(snapshot.uidByPid.get(process.pid), resolveTrustedProcessUid({}, process.getuid)), true);
});
