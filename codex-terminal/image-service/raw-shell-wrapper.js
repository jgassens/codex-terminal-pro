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

module.exports = { buildMarkedShellCommand, quoteShellWord };
