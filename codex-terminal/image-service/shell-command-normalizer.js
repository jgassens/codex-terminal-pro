'use strict';

const fs = require('fs');
const path = require('path');

const DISPATCH_PREFIX = ',,';

function firstShellWord(command) {
    return String(command || '').trim().split(/\s+/)[0] || '';
}

function stripRepeatedDispatchPrefixes(command) {
    let value = String(command || '').trim();
    let stripped = false;

    while (value.startsWith(DISPATCH_PREFIX)) {
        value = value.slice(DISPATCH_PREFIX.length).replace(/^\s+/, '');
        stripped = true;
    }

    return { command: value, stripped };
}

function commandExists(commandName, envPath = process.env.PATH || '') {
    if (!commandName || /[\u0000-\u001f\u007f]/.test(commandName)) {
        return false;
    }

    if (commandName.includes('/')) {
        try {
            fs.accessSync(commandName, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    return envPath.split(path.delimiter).some((dir) => {
        if (!dir) {
            return false;
        }

        try {
            fs.accessSync(path.join(dir, commandName), fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}

function repairDuplicateFanout(value, maxLag = 3) {
    const pending = [];
    let repaired = '';

    for (const char of String(value || '')) {
        const index = pending.indexOf(char);
        if (index !== -1 && index < maxLag) {
            pending.splice(index, 1);
            continue;
        }

        repaired += char;
        pending.push(char);
        if (pending.length > maxLag) {
            pending.shift();
        }
    }

    return repaired.replace(/\s+/g, ' ').trim();
}

function reductionRatio(original, repaired) {
    if (!original) {
        return 0;
    }

    return (original.length - repaired.length) / original.length;
}

function normalizeShellCommandForDispatch(command, options = {}) {
    const trimmed = String(command || '').trim();
    if (!trimmed) {
        return '';
    }

    const exists = options.commandExists || commandExists;
    const originalFirst = firstShellWord(trimmed);
    const prefixStripped = stripRepeatedDispatchPrefixes(trimmed);
    const candidates = [];

    for (const value of [prefixStripped.command, trimmed]) {
        const repaired = repairDuplicateFanout(value);
        if (repaired && repaired !== trimmed) {
            candidates.push({
                command: repaired,
                basis: value,
                force: false
            });
        }
    }

    if (prefixStripped.stripped && prefixStripped.command) {
        candidates.push({
            command: prefixStripped.command,
            basis: trimmed,
            force: true
        });
    }

    const seen = new Set();
    for (const candidate of candidates) {
        const value = candidate.command;
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);

        const first = firstShellWord(value);
        if (!first) {
            continue;
        }

        if (
            exists(first) &&
            (
                candidate.force ||
                !exists(originalFirst) &&
                reductionRatio(candidate.basis || trimmed, value) >= 0.35
            )
        ) {
            return value;
        }
    }

    if (prefixStripped.stripped && prefixStripped.command) {
        return prefixStripped.command;
    }

    return trimmed;
}

module.exports = {
    commandExists,
    firstShellWord,
    normalizeShellCommandForDispatch,
    repairDuplicateFanout,
    stripRepeatedDispatchPrefixes
};
