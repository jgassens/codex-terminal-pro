'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
    buildCodexDispatchedShellCommand,
    buildMarkedShellCommand
} = require('./raw-shell-wrapper');

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

test('loopback Codex dispatch marks only its child shell', () => {
    const command = buildCodexDispatchedShellCommand(
        `printf '%s|%s\\n' "$CODEX_TERMINAL_AGENT_EXECUTION" "it's intact"`
    );
    const cleanEnvironment = { ...process.env };
    delete cleanEnvironment.CODEX_TERMINAL_AGENT_EXECUTION;
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc'], {
        input: `${command}\nprintf 'parent:%s\\n' "\${CODEX_TERMINAL_AGENT_EXECUTION-unset}"\n`,
        encoding: 'utf8',
        env: cleanEnvironment
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^1\|it's intact$/m);
    assert.match(result.stdout, /^parent:unset$/m);
});
