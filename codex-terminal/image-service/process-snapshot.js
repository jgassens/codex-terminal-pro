'use strict';

const { execFile } = require('child_process');

// procps-ng (the Alpine `ps` in the add-on) renders `user` in an 8-character
// column and cuts longer names to `ctp-cla+`, so the fixed consultant users
// (ctp-claude, ctp-kimi, ctp-codex) would no longer match their names and
// distinct accounts could collide. `user:32` asks for a column wide enough for
// any local account name. BSD ps (the developer harness on macOS) rejects the
// `:width` syntax, so a failed first call falls back to plain `user`, whose
// column is 8 wide.
const WIDE_USER_COLUMN = 32;
const NARROW_USER_COLUMN = 8;
const PS_FORMATS = [
    { columns: `pid=,ppid=,user:${WIDE_USER_COLUMN}=,args=`, userColumnWidth: WIDE_USER_COLUMN },
    { columns: 'pid=,ppid=,user=,args=', userColumnWidth: NARROW_USER_COLUMN }
];

// A name that fills its column or ends in procps's '+' marker may have been
// cut short and could stand for several accounts. Report it as an empty user,
// which never equals a trusted user name, so the sign-in trust check fails
// closed.
function isAmbiguousUser(user, userColumnWidth) {
    return user.endsWith('+') || user.length >= userColumnWidth;
}

function parseProcessSnapshot(stdout, { userColumnWidth = WIDE_USER_COLUMN } = {}) {
    const children = new Map();
    const argsByPid = new Map();
    const userByPid = new Map();
    for (const line of String(stdout).split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) {
            continue;
        }
        const [, pid, ppid, user, args] = match;
        const numericPid = Number(pid);
        const numericParent = Number(ppid);
        argsByPid.set(numericPid, args.trim());
        userByPid.set(numericPid, isAmbiguousUser(user, userColumnWidth) ? '' : user);
        if (!children.has(numericParent)) {
            children.set(numericParent, []);
        }
        children.get(numericParent).push(numericPid);
    }
    return { children, argsByPid, userByPid };
}

function readProcessSnapshot(callback, formatIndex = 0) {
    const { columns, userColumnWidth } = PS_FORMATS[formatIndex];
    execFile('ps', ['-e', '-o', columns], { timeout: 3000 }, (err, stdout) => {
        if (err) {
            // Only a non-zero exit means ps disliked the format; a timeout or
            // a missing binary would fail the same way again.
            if (typeof err.code === 'number' && formatIndex + 1 < PS_FORMATS.length) {
                readProcessSnapshot(callback, formatIndex + 1);
                return;
            }
            callback(err);
            return;
        }
        callback(null, parseProcessSnapshot(stdout, { userColumnWidth }));
    });
}

module.exports = { parseProcessSnapshot, readProcessSnapshot };
