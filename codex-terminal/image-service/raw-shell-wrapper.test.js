'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { buildMarkedShellCommand } = require('./raw-shell-wrapper');

test('malformed user shell syntax cannot suppress completion markers', () => {
    const command = buildMarkedShellCommand(
        'echo "unterminated',
        '__START_MARKER__',
        '__END_MARKER__'
    );
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc'], {
        input: `${command}\n`,
        encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /__START_MARKER__/);
    assert.match(result.stdout, /__END_MARKER__:[1-9][0-9]*/);
    assert.match(result.stderr, /unexpected EOF|matching/);
});

test('single quotes in valid commands survive the wrapper exactly', () => {
    const command = buildMarkedShellCommand(
        `printf '%s\\n' "it's intact"`,
        '__START_MARKER__',
        '__END_MARKER__'
    );
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc'], {
        input: `${command}\n`,
        encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /it's intact/);
    assert.match(result.stdout, /__END_MARKER__:0/);
});
