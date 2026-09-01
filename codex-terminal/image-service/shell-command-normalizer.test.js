'use strict';

const assert = require('assert');
const { normalizeShellCommandForDispatch } = require('./shell-command-normalizer');

assert.strictEqual(
    normalizeShellCommandForDispatch(',,hhaa ccoorer e reresstartartt'),
    'hhaa ccoorer e reresstartartt'
);

assert.strictEqual(
    normalizeShellCommandForDispatch('hhaa c coorer er ereststarartt'),
    'hhaa c coorer er ereststarartt'
);

assert.strictEqual(
    normalizeShellCommandForDispatch(',,printf ",,"'),
    'printf ",,"'
);

assert.strictEqual(
    normalizeShellCommandForDispatch('ssh root@homeassistant'),
    'ssh root@homeassistant'
);

assert.strictEqual(
    normalizeShellCommandForDispatch('eccho hi'),
    'eccho hi'
);

assert.strictEqual(
    normalizeShellCommandForDispatch(',,,,printf "%s %s" "a b" "c"'),
    'printf "%s %s" "a b" "c"'
);

console.log('shell-command-normalizer: ok');
