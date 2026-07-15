'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const { endChildStdin } = require('./child-stdin');

const DEFAULT_TMUX_LOAD_BUFFER_TIMEOUT_MS = 3000;

function createTmuxPasteBufferName(prefix = 'codex-terminal-paste') {
    return `${prefix}-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function loadTmuxPasteBuffer(text, options = {}, callback) {
    const spawnProcess = options.spawnProcess || spawn;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
        ? options.timeoutMs
        : DEFAULT_TMUX_LOAD_BUFFER_TIMEOUT_MS;
    const bufferName = options.bufferName || createTmuxPasteBufferName();
    let loader;

    try {
        loader = spawnProcess('tmux', ['load-buffer', '-b', bufferName, '-'], {
            stdio: ['pipe', 'ignore', 'pipe']
        });
    } catch (err) {
        callback(err);
        return null;
    }

    let stderr = '';
    let settled = false;
    let timeout = null;

    const finish = (err) => {
        if (settled) {
            return;
        }
        settled = true;
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        callback(err || null, err ? undefined : bufferName);
    };

    const killLoader = () => {
        try {
            loader.kill('SIGKILL');
        } catch {
            // Preserve the original loader error or timeout.
        }
    };

    const fail = (err) => {
        killLoader();
        finish(err);
    };

    loader.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    loader.on('error', fail);
    loader.on('close', (code) => {
        if (code !== 0) {
            const err = new Error(stderr.trim() || `tmux load-buffer exited ${code}`);
            err.code = 'TMUX_LOAD_BUFFER_FAILED';
            finish(err);
            return;
        }
        finish(null);
    });

    if (timeoutMs > 0) {
        timeout = setTimeout(() => {
            const err = new Error(`tmux load-buffer timed out after ${timeoutMs}ms`);
            err.code = 'TMUX_LOAD_BUFFER_TIMEOUT';
            fail(err);
        }, timeoutMs);
    }

    endChildStdin(loader.stdin, text, fail);
    return loader;
}

module.exports = {
    DEFAULT_TMUX_LOAD_BUFFER_TIMEOUT_MS,
    createTmuxPasteBufferName,
    loadTmuxPasteBuffer
};
