'use strict';

const { execFile } = require('child_process');

// Processes are identified by numeric uid, not user name: procps-ng (the
// Alpine `ps` in the add-on) cuts names to an 8-character column and BSD ps
// (the developer harness on macOS) rejects procps's `user:32` width syntax,
// while both print `uid` in full. `-ww` lifts the args width limit an
// exported COLUMNS would otherwise impose, so a long wrapper command such as
// `/bin/bash /usr/local/bin/claude-auth-helper` is never cut short. procps-ng
// 4.0.4 and macOS ps both accept these exact arguments.
const PS_ARGS = ['-ww', '-e', '-o', 'pid=,ppid=,uid=,args='];

// A row is `pid ppid uid args`, all three ids decimal. A row that does not
// match exactly leaves no entry, so its process has no uid and can never equal
// a trusted uid.
const ROW = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/;

function parseProcessSnapshot(stdout) {
    const children = new Map();
    const argsByPid = new Map();
    const uidByPid = new Map();
    for (const line of String(stdout).split('\n')) {
        const match = line.trim().match(ROW);
        if (!match) {
            continue;
        }
        const [, pid, ppid, uid, args] = match;
        const numericPid = Number(pid);
        const numericParent = Number(ppid);
        const numericUid = Number(uid);
        if (![numericPid, numericParent, numericUid].every(Number.isSafeInteger)) {
            continue;
        }
        argsByPid.set(numericPid, args.trim());
        uidByPid.set(numericPid, numericUid);
        if (!children.has(numericParent)) {
            children.set(numericParent, []);
        }
        children.get(numericParent).push(numericPid);
    }
    return { children, argsByPid, uidByPid };
}

function readProcessSnapshot(callback) {
    execFile('ps', PS_ARGS, { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
            callback(err);
            return;
        }
        callback(null, parseProcessSnapshot(stdout));
    });
}

// The uid whose processes the sign-in check trusts: SIGNIN_TRUSTED_PROCESS_UID
// when set, otherwise this service's own uid (root, 0, in the add-on; the
// developer's account in the host harness). A value that is not a plain
// decimal uid resolves to null, which trusts nothing. The retired
// SIGNIN_TRUSTED_PROCESS_USER named an account; set on its own it is no longer
// honoured, and it also trusts nothing rather than silently widening trust to
// the service's uid.
function resolveTrustedProcessUid(env = process.env, getuid = process.getuid) {
    const configured = env.SIGNIN_TRUSTED_PROCESS_UID;
    if (configured !== undefined && configured !== '') {
        return /^\d+$/.test(configured) && Number.isSafeInteger(Number(configured)) ? Number(configured) : null;
    }
    if (env.SIGNIN_TRUSTED_PROCESS_USER) {
        return null;
    }
    const uid = typeof getuid === 'function' ? getuid() : undefined;
    return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function isTrustedProcessUid(uid, trustedUid) {
    return Number.isSafeInteger(trustedUid) && Number.isSafeInteger(uid) && uid === trustedUid;
}

module.exports = {
    PS_ARGS,
    isTrustedProcessUid,
    parseProcessSnapshot,
    readProcessSnapshot,
    resolveTrustedProcessUid
};
