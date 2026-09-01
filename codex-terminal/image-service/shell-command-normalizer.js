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

function normalizeShellCommandForDispatch(command, options = {}) {
    const trimmed = String(command || '').trim();
    if (!trimmed) {
        return '';
    }
    const prefixStripped = stripRepeatedDispatchPrefixes(trimmed);
    return prefixStripped.stripped ? prefixStripped.command : trimmed;
}

module.exports = {
    commandExists,
    firstShellWord,
    normalizeShellCommandForDispatch,
    stripRepeatedDispatchPrefixes
};
