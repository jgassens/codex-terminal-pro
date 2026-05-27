'use strict';

const assert = require('assert');
const {
    normalizeShellCommandForDispatch,
    repairDuplicateFanout
} = require('./shell-command-normalizer');

const executableNames = new Set(['ha', 'printf', 'ssh']);
const commandExists = (name) => executableNames.has(name);

assert.strictEqual(
    repairDuplicateFanout('hhaa ccoorer e reresstartartt'),
    'ha core restart'
);

assert.strictEqual(
    normalizeShellCommandForDispatch(',,hhaa ccoorer e reresstartartt', { commandExists }),
    'ha core restart'
);

assert.strictEqual(
    normalizeShellCommandForDispatch('hhaa c coorer er ereststarartt', { commandExists }),
    'ha core restart'
);

assert.strictEqual(
    normalizeShellCommandForDispatch(',,printf ",,"', { commandExists }),
    'printf ",,"'
);

assert.strictEqual(
    normalizeShellCommandForDispatch('ssh root@homeassistant', { commandExists }),
    'ssh root@homeassistant'
);

assert.strictEqual(
    normalizeShellCommandForDispatch('eccho hi', { commandExists: (name) => name === 'echo' }),
    'eccho hi'
);

console.log('shell-command-normalizer: ok');
