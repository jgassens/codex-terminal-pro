'use strict';

function quoteShellWord(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildMarkedShellCommand(command, startMarker, endMarker) {
    // Keep the user command as data until eval. Malformed user quoting can then
    // fail without preventing the wrapper's start/end markers from running.
    return [
        `printf '\\n${startMarker}\\n'`,
        `eval -- ${quoteShellWord(command)}`,
        '__ctp_status=$?',
        `printf '\\n${endMarker}:%s\\n' "$__ctp_status"`
    ].join('; ');
}

function buildCodexDispatchedShellCommand(command) {
    // Run the loopback Codex fallback in a child shell so its actor marker does
    // not leak into the persistent human shell after the command completes.
    return [
        'env CODEX_TERMINAL_AGENT_EXECUTION=1',
        '/bin/bash --noprofile --norc -c',
        quoteShellWord(command)
    ].join(' ');
}

module.exports = {
    buildCodexDispatchedShellCommand,
    buildMarkedShellCommand,
    quoteShellWord
};
