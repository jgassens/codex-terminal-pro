#!/usr/bin/env node

/**
 * Codex Terminal Pro - Image Upload Service
 *
 * Lightweight Express server that handles image uploads from browser paste/drag-drop.
 * Designed for resource-constrained environments (Raspberry Pi).
 *
 * Features:
 * - Serves custom HTML interface with embedded ttyd terminal
 * - Handles image uploads via POST /upload
 * - Saves images to /data/images (persistent storage)
 * - Returns file paths for use with Codex CLI
 * - ARM-compatible (no native dependencies)
 */

const express = require('express');
const http = require('http');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { normalizeShellCommandForDispatch } = require('./shell-command-normalizer');
const {
    buildRequestSecurityPolicy,
    isAllowedRequestSource,
    isAuthorizedWebSocketRequest,
    isLoopbackAddress,
    isSameOriginBrowserRequest,
    requestRemoteAddress
} = require('./request-security');
const { parseJsonLinesTail, writeFileAtomic } = require('./persistence-utils');
const { createSerialTaskQueue } = require('./serial-task-queue');
const { buildMarkedShellCommand } = require('./raw-shell-wrapper');
const { endChildStdin } = require('./child-stdin');
const { loadTmuxPasteBuffer } = require('./tmux-paste-buffer');
const {
    JAIL_GID,
    JAIL_ROOT,
    JAIL_UID,
    SANDBOX_WORK_ROOT,
    buildMallCopCodexArgs,
    buildMallCopCodexEnvironment,
    buildMallCopJailLauncherArgs,
    prepareMallCopSandbox,
    refreshMallCopJailRuntimeFiles,
    protectMallCopPrompt
} = require('./mall-cop-isolation');

const app = express();
const PORT = parsePort(process.env.IMAGE_SERVICE_PORT, 7680);
const TTYD_PORT = parsePort(process.env.TTYD_PORT, 7681);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/images';
const CONFIG_ROOT = process.env.HA_CONFIG_DIR || '/config';
const HA_MONITOR_STATE_FILE = process.env.HA_MONITOR_STATE_FILE || '/data/monitor/ha-monitor.json';
const HA_MONITOR_HISTORY_FILE = process.env.HA_MONITOR_HISTORY_FILE || '/data/monitor/ha-monitor-history.jsonl';
const CHANGE_DESK_DISPATCH_FILE = process.env.CHANGE_DESK_DISPATCH_FILE || '/data/monitor/change-desk-dispatch.json';
const CHANGE_DESK_REPORT_DIR = process.env.CHANGE_DESK_REPORT_DIR || '/data/monitor/reports';
const CHANGE_DESK_MALL_COP_MEMORY_FILE = process.env.CHANGE_DESK_MALL_COP_MEMORY_FILE || '/data/monitor/change-desk-mall-cop-memory.json';
const CODEX_TMUX_TARGET = process.env.CODEX_TMUX_TARGET || process.env.TMUX_TARGET || 'codex-terminal:0.0';
const TMUX_SESSION = process.env.TMUX_SESSION || CODEX_TMUX_TARGET.split(':')[0] || 'codex-terminal';
const RAW_TERMINAL_WINDOW = process.env.RAW_TERMINAL_WINDOW || 'raw-shell';
const RAW_TMUX_TARGET = `${TMUX_SESSION}:${RAW_TERMINAL_WINDOW}.0`;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const RAW_SHELL_COMMAND_MAX_LENGTH = 4096;
const RAW_SHELL_COMMAND_TIMEOUT_MS = parseNonNegativeInt(process.env.RAW_SHELL_COMMAND_TIMEOUT_MS, 45000);
const RAW_SHELL_TERMINATION_GRACE_MS = parseNonNegativeInt(process.env.RAW_SHELL_TERMINATION_GRACE_MS, 1500);
const RAW_SHELL_CAPTURE_LINES = parseNonNegativeInt(process.env.RAW_SHELL_CAPTURE_LINES, 4000);
const RAW_SHELL_OUTPUT_MAX_CHARS = parseNonNegativeInt(process.env.RAW_SHELL_OUTPUT_MAX_CHARS, 20000);
const RAW_SHELL_MAX_PENDING_COMMANDS = parseNonNegativeInt(process.env.RAW_SHELL_MAX_PENDING_COMMANDS, 8);
const RAW_SHELL_QUEUE_WAIT_TIMEOUT_MS = parseNonNegativeInt(process.env.RAW_SHELL_QUEUE_WAIT_TIMEOUT_MS, 5000);
const CHANGE_DESK_COMMAND_TIMEOUT_MS = parseNonNegativeInt(process.env.CHANGE_DESK_COMMAND_TIMEOUT_MS, 45000);
const CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS = parseNonNegativeInt(process.env.CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS, 12000);
const CHANGE_DESK_OUTPUT_MAX_CHARS = parseNonNegativeInt(process.env.CHANGE_DESK_OUTPUT_MAX_CHARS, 12000);
const CHANGE_DESK_LOG_OUTPUT_MAX_CHARS = parseNonNegativeInt(process.env.CHANGE_DESK_LOG_OUTPUT_MAX_CHARS, 60000);
const CHANGE_DESK_LOG_LINE_LIMIT = parseNonNegativeInt(process.env.CHANGE_DESK_LOG_LINE_LIMIT, 500);
const CHANGE_DESK_REPORT_MAX_CHARS = parseNonNegativeInt(process.env.CHANGE_DESK_REPORT_MAX_CHARS, 200000);
const CHANGE_DESK_MALL_COP_TIMEOUT_MS = parseNonNegativeInt(process.env.CHANGE_DESK_MALL_COP_TIMEOUT_MS, 180000);
const CHANGE_DESK_MALL_COP_MAX_CHARS = parseNonNegativeInt(process.env.CHANGE_DESK_MALL_COP_MAX_CHARS, 18000);
const CHANGE_DESK_MALL_COP_AUTO_INTERVAL_SECONDS = parseNonNegativeInt(process.env.CHANGE_DESK_MALL_COP_AUTO_INTERVAL_SECONDS, 86400);
const HA_MONITOR_HISTORY_READ_MAX_BYTES = parseNonNegativeInt(process.env.HA_MONITOR_HISTORY_READ_MAX_BYTES, 2 * 1024 * 1024);
const IMAGE_RETENTION_DAYS = parseNonNegativeInt(process.env.IMAGE_RETENTION_DAYS, 30);
const IMAGE_RETENTION_MAX_BYTES = parseNonNegativeInt(process.env.IMAGE_RETENTION_MAX_BYTES, 256 * 1024 * 1024);
const SCROLL_CONTROL_ACTIONS = new Set(['scroll-up', 'scroll-down', 'scroll-bottom']);
const LIVE_CONTROL_KEYS = new Map([
    ['ctrl-c', 'C-c'],
    ['ctrl-d', 'C-d'],
    ['ctrl-z', 'C-z'],
    ['ctrl-l', 'C-l'],
    ['ctrl-u', 'C-u'],
    ['tab', 'Tab'],
    ['enter', 'Enter'],
    ['up', 'Up'],
    ['down', 'Down']
]);
const SUPPORTED_TERMINAL_CONTROL_ACTIONS = new Set([
    ...SCROLL_CONTROL_ACTIONS,
    ...LIVE_CONTROL_KEYS.keys()
]);
const TERMINAL_MODES = new Set(['codex', 'raw']);
let activeTerminalMode = 'codex';
let mallCopRunInFlight = null;
const requestSecurityPolicy = buildRequestSecurityPolicy();
const rawShellCommandQueue = createSerialTaskQueue({
    maxPending: RAW_SHELL_MAX_PENDING_COMMANDS,
    maxWaitMs: RAW_SHELL_QUEUE_WAIT_TIMEOUT_MS
});
const ALLOWED_IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence'
]);
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.heic', '.heif']);

function parseNonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePort(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function extensionForMime(mimetype) {
    switch (mimetype) {
        case 'image/jpeg':
            return '.jpg';
        case 'image/png':
            return '.png';
        case 'image/gif':
            return '.gif';
        case 'image/webp':
            return '.webp';
        case 'image/svg+xml':
            return '.svg';
        case 'image/heic':
        case 'image/heic-sequence':
            return '.heic';
        case 'image/heif':
        case 'image/heif-sequence':
            return '.heif';
        default:
            return '.png';
    }
}

function isAllowedImage(file) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    return ALLOWED_IMAGE_MIMES.has(file.mimetype) || ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}

function hasUnsupportedPasteCharacters(value) {
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function readFileHead(filePath, maxBytes = 4096) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        fs.closeSync(fd);
    }
}

function ascii(buffer, start = 0, end = buffer.length) {
    return buffer.subarray(start, Math.min(end, buffer.length)).toString('ascii');
}

function isValidSvg(buffer) {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 4096).toLowerCase();
    const svgStart = text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'));
    const activeContent = /<script|onload\s*=|javascript:/i.test(text);
    return svgStart && !activeContent;
}

function isValidImageContent(filePath, mimetype, filename) {
    const ext = path.extname(filename || '').toLowerCase();
    const head = readFileHead(filePath);

    if (head.length < 4) {
        return false;
    }

    if (ext === '.jpg' || ext === '.jpeg' || mimetype === 'image/jpeg') {
        return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    }

    if (ext === '.png' || mimetype === 'image/png') {
        return head.length >= 8 &&
            head[0] === 0x89 &&
            ascii(head, 1, 4) === 'PNG' &&
            head[4] === 0x0d &&
            head[5] === 0x0a &&
            head[6] === 0x1a &&
            head[7] === 0x0a;
    }

    if (ext === '.gif' || mimetype === 'image/gif') {
        const signature = ascii(head, 0, 6);
        return signature === 'GIF87a' || signature === 'GIF89a';
    }

    if (ext === '.webp' || mimetype === 'image/webp') {
        return head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP';
    }

    if (ext === '.heic' || ext === '.heif' || mimetype.includes('heic') || mimetype.includes('heif')) {
        const brandText = ascii(head, 4, 64).toLowerCase();
        return brandText.startsWith('ftyp') && /(heic|heix|hevc|hevx|mif1|msf1)/.test(brandText);
    }

    if (ext === '.svg' || mimetype === 'image/svg+xml') {
        return isValidSvg(head);
    }

    return false;
}

function runTmux(args, callback, timeout = 3000) {
    execFile('tmux', args, { timeout }, callback);
}

function targetForMode(mode) {
    return mode === 'raw' ? RAW_TMUX_TARGET : CODEX_TMUX_TARGET;
}

function windowTargetForMode(mode) {
    return targetForMode(mode).replace(/\.\d+$/, '');
}

function activeTmuxTarget() {
    return targetForMode(activeTerminalMode);
}

function getPaneInMode(callback, target = activeTmuxTarget()) {
    runTmux(['display-message', '-p', '-t', target, '#{pane_in_mode}'], (err, stdout) => {
        if (err) {
            callback(err);
            return;
        }

        callback(null, String(stdout).trim() === '1');
    });
}

// tmux prints one line per attached client. Every browser holding the shared
// window open is one client, so this is how many devices are currently
// constraining the window size.
function countTmuxClients(stdout) {
    return String(stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .length;
}

function readAttachedClientCount(callback) {
    runTmux(['list-clients', '-t', TMUX_SESSION, '-F', '#{client_name}'], (err, stdout) => {
        if (err) {
            callback(err);
            return;
        }

        callback(null, countTmuxClients(stdout));
    });
}

function cancelCopyModeIfNeeded(callback, target = activeTmuxTarget()) {
    getPaneInMode((modeErr, inMode) => {
        if (modeErr) {
            callback(modeErr);
            return;
        }

        if (!inMode) {
            callback(null);
            return;
        }

        runTmux(['send-keys', '-t', target, '-X', 'cancel'], callback);
    }, target);
}

function pasteTextToTarget(text, target, logContext, callback) {
    cancelCopyModeIfNeeded((modeErr) => {
        if (modeErr) {
            callback(modeErr);
            return;
        }

        loadTmuxPasteBuffer(text, {}, (err, bufferName) => {
            if (err) {
                console.error(`Failed to load tmux paste buffer for ${logContext}:`, err.message);
                callback(err);
                return;
            }
            runTmux(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', target], callback);
        });
    }, target);
}

function capturePaneText(target, callback) {
    runTmux([
        'capture-pane',
        '-p',
        '-J',
        '-t',
        target,
        '-S',
        `-${RAW_SHELL_CAPTURE_LINES}`
    ], callback);
}

function truncateShellOutput(output) {
    if (output.length <= RAW_SHELL_OUTPUT_MAX_CHARS) {
        return { output, truncated: false };
    }

    const notice = '\n...[output truncated]\n';
    const keep = Math.max(0, RAW_SHELL_OUTPUT_MAX_CHARS - notice.length);
    return {
        output: `${output.slice(0, keep)}${notice}`,
        truncated: true
    };
}

function truncateShellOutputTail(output) {
    if (output.length <= RAW_SHELL_OUTPUT_MAX_CHARS) {
        return { output, truncated: false };
    }

    const notice = '...[earlier output truncated]\n';
    const keep = Math.max(0, RAW_SHELL_OUTPUT_MAX_CHARS - notice.length);
    return {
        output: `${notice}${output.slice(-keep)}`,
        truncated: true
    };
}

function parseMarkedShellOutput(captured, startMarker, endMarker) {
    const lines = String(captured || '').replace(/\r/g, '').split('\n');
    const endPrefix = `${endMarker}:`;
    let startIndex = -1;
    let endIndex = -1;
    let exitCode = null;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line.startsWith(endPrefix)) {
            endIndex = i;
            const parsed = Number.parseInt(line.slice(endPrefix.length), 10);
            exitCode = Number.isFinite(parsed) ? parsed : null;
            break;
        }
        if (startIndex === -1) {
            if (line === startMarker) {
                startIndex = i;
            }
            continue;
        }
    }

    if (startIndex === -1) {
        if (endIndex !== -1) {
            // The unique end marker proves this command completed even when a
            // very chatty command pushed its start marker out of capture-pane.
            const rawOutput = lines
                .slice(0, endIndex)
                .join('\n')
                .replace(/^\n+/, '')
                .replace(/\n+$/, '');
            const truncated = truncateShellOutputTail(rawOutput);
            return {
                started: true,
                complete: true,
                output: truncated.output,
                exitCode,
                truncated: true
            };
        }
        return { started: false, complete: false, output: '', exitCode: null, truncated: false };
    }

    if (endIndex === -1) {
        const partialOutput = lines
            .slice(startIndex + 1)
            .join('\n')
            .replace(/^\n+/, '')
            .replace(/\n+$/, '');
        const truncated = truncateShellOutput(partialOutput);
        return {
            started: true,
            complete: false,
            output: truncated.output,
            exitCode: null,
            truncated: truncated.truncated
        };
    }

    const rawOutput = lines
        .slice(startIndex + 1, endIndex)
        .join('\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');
    const truncated = truncateShellOutput(rawOutput);
    return {
        started: true,
        complete: true,
        output: truncated.output,
        exitCode,
        truncated: truncated.truncated
    };
}

function waitForMarkedShellOutput(startMarker, endMarker, timeoutMs, callback) {
    const deadline = Date.now() + timeoutMs;

    const poll = () => {
        capturePaneText(RAW_TMUX_TARGET, (captureErr, stdout) => {
            if (captureErr) {
                callback(captureErr);
                return;
            }

            const parsed = parseMarkedShellOutput(stdout, startMarker, endMarker);
            if (parsed.complete) {
                callback(null, { ...parsed, timedOut: false });
                return;
            }

            if (Date.now() >= deadline) {
                callback(null, { ...parsed, timedOut: true });
                return;
            }

            setTimeout(poll, 250);
        });
    };

    poll();
}

function rawShellRespawnArgs() {
    return [
        'respawn-pane',
        '-k',
        '-t',
        RAW_TMUX_TARGET,
        '-c',
        '/config',
        'env CODEX_TERMINAL_HUMAN_SHELL=1 /bin/bash -l'
    ];
}

function rawShellIsolationFailure(precedingError, respawnError) {
    const error = new Error('Raw shell isolation failed; restarting the image service');
    error.code = 'RAW_SHELL_ISOLATION_FAILED';
    error.poisonQueue = true;
    error.cause = respawnError || precedingError;
    console.error(
        'Unable to replace the raw shell after an ambiguous command state:',
        respawnError?.message || 'unknown respawn failure',
        precedingError ? `(preceding error: ${precedingError.message})` : ''
    );
    const restartTimer = setTimeout(() => process.exit(1), 250);
    restartTimer.unref();
    return error;
}

function resetRawShellAfterAmbiguousDispatch(precedingError, callback) {
    // Once text may have reached the pane, an observation error means the
    // command may still be running. Replace the pane before the serial queue is
    // allowed to dispatch anything else.
    runTmux(rawShellRespawnArgs(), (respawnError) => {
        if (respawnError) {
            callback(rawShellIsolationFailure(precedingError, respawnError));
            return;
        }

        const error = new Error('Raw shell command state became ambiguous; the shell was reset');
        error.code = 'RAW_SHELL_STATE_AMBIGUOUS';
        error.cause = precedingError;
        callback(error);
    });
}

function terminateTimedOutRawShell(startMarker, endMarker, timedOutResult, callback) {
    const hardRespawn = (partialResult, precedingError) => {
        // Replacing the pane is the hard isolation boundary: no queued command
        // may be pasted until the timed-out process is certainly gone.
        runTmux(rawShellRespawnArgs(), (respawnErr) => {
            if (respawnErr) {
                callback(rawShellIsolationFailure(precedingError, respawnErr));
                return;
            }

            callback(null, {
                ...timedOutResult,
                output: partialResult?.output || timedOutResult.output || '',
                truncated: Boolean(partialResult?.truncated || timedOutResult.truncated),
                timedOut: true,
                terminated: true
            });
        });
    };

    runTmux(['send-keys', '-t', RAW_TMUX_TARGET, 'C-c'], (interruptErr) => {
        if (interruptErr) {
            hardRespawn(timedOutResult, interruptErr);
            return;
        }

        waitForMarkedShellOutput(
            startMarker,
            endMarker,
            RAW_SHELL_TERMINATION_GRACE_MS,
            (graceErr, graceResult) => {
                if (graceErr) {
                    hardRespawn(timedOutResult, graceErr);
                    return;
                }

                if (graceResult.complete) {
                    callback(null, {
                        ...graceResult,
                        timedOut: true,
                        terminated: true
                    });
                    return;
                }

                hardRespawn(graceResult, null);
            }
        );
    });
}

function ensureRawTerminal(callback) {
    runTmux(['list-windows', '-t', TMUX_SESSION, '-F', '#{window_name}'], (listErr, stdout) => {
        if (listErr) {
            callback(listErr);
            return;
        }

        const windows = String(stdout || '').split(/\r?\n/);
        if (windows.includes(RAW_TERMINAL_WINDOW)) {
            callback(null);
            return;
        }

        runTmux([
            'new-window',
            '-d',
            '-t',
            TMUX_SESSION,
            '-n',
            RAW_TERMINAL_WINDOW,
            '-c',
            '/config',
            'env CODEX_TERMINAL_HUMAN_SHELL=1 /bin/bash -l'
        ], callback);
    });
}

function selectTerminalMode(mode, callback) {
    if (!TERMINAL_MODES.has(mode)) {
        callback(new Error('Unsupported terminal mode'));
        return;
    }

    const selectTarget = targetForMode(mode);
    const selectWindowTarget = windowTargetForMode(mode);

    const selectTargetWindow = () => {
        runTmux(['select-window', '-t', selectWindowTarget], (windowErr) => {
            if (windowErr) {
                callback(windowErr);
                return;
            }

            runTmux(['select-pane', '-t', selectTarget], (paneErr) => {
                if (paneErr) {
                    callback(paneErr);
                    return;
                }

                activeTerminalMode = mode;
                callback(null);
            });
        });
    };

    if (mode === 'raw') {
        ensureRawTerminal((ensureErr) => {
            if (ensureErr) {
                callback(ensureErr);
                return;
            }

            selectTargetWindow();
        });
        return;
    }

    selectTargetWindow();
}

function dispatchRawShellCommand(command, callback) {
    const previousMode = activeTerminalMode;
    const finish = (result) => {
        selectTerminalMode(previousMode, (restoreErr) => {
            if (restoreErr) {
                console.error(`Unable to restore terminal mode ${previousMode}:`, restoreErr.message);
            }
            callback(null, {
                ...result,
                mode: activeTerminalMode
            });
        });
    };

    ensureRawTerminal((ensureErr) => {
        if (ensureErr) {
            callback(ensureErr);
            return;
        }

        const markerSuffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const startMarker = `__CTP_SHELL_START_${markerSuffix}__`;
        const endMarker = `__CTP_SHELL_END_${markerSuffix}__`;
        const wrappedCommand = buildMarkedShellCommand(command, startMarker, endMarker);

        cancelCopyModeIfNeeded((modeErr) => {
            if (modeErr) {
                callback(modeErr);
                return;
            }

            runTmux(['send-keys', '-t', RAW_TMUX_TARGET, 'C-u'], (clearErr) => {
                if (clearErr) {
                    callback(clearErr);
                    return;
                }

                pasteTextToTarget(wrappedCommand, RAW_TMUX_TARGET, RAW_TMUX_TARGET, (pasteErr) => {
                    if (pasteErr) {
                        resetRawShellAfterAmbiguousDispatch(pasteErr, callback);
                        return;
                    }

                    // Make prompts from guarded shell commands visible before
                    // pressing Enter so the human can answer them in the raw
                    // terminal instead of waiting on a hidden pane.
                    selectTerminalMode('raw', (selectErr) => {
                        if (selectErr) {
                            resetRawShellAfterAmbiguousDispatch(selectErr, callback);
                            return;
                        }

                        runTmux(['send-keys', '-t', RAW_TMUX_TARGET, 'Enter'], (enterErr) => {
                            if (enterErr) {
                                resetRawShellAfterAmbiguousDispatch(enterErr, callback);
                                return;
                            }

                            waitForMarkedShellOutput(startMarker, endMarker, RAW_SHELL_COMMAND_TIMEOUT_MS, (waitErr, result) => {
                                if (waitErr) {
                                    resetRawShellAfterAmbiguousDispatch(waitErr, callback);
                                    return;
                                }

                                if (result.timedOut) {
                                    terminateTimedOutRawShell(startMarker, endMarker, result, (terminateErr, terminatedResult) => {
                                        if (terminateErr) {
                                            callback(terminateErr);
                                            return;
                                        }

                                        finish(terminatedResult);
                                    });
                                    return;
                                }

                                finish(result);
                            });
                        });
                    });
                });
            });
        }, RAW_TMUX_TARGET);
    });
}

function enqueueRawShellCommand(command, callback, options = {}) {
    return rawShellCommandQueue.enqueue(
        (done) => dispatchRawShellCommand(command, done),
        callback,
        options
    );
}

function stripAnsiText(value) {
    return String(value || '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\ufffd\[[0-?]*[ -/]*[@-~]/g, '');
}

function redactSensitiveText(value) {
    return stripAnsiText(value)
        .replace(/\/data\/\.codex\/auth\.json/g, '/data/.codex/[redacted-auth].json')
        .replace(/\/data\/\.supervisor\/token/g, '/data/.supervisor/[redacted-token]')
        .replace(
            /([a-z][a-z0-9+.-]{0,31}:\/\/)([^/\s:@]+):([^@/\s]+)@/gi,
            '$1[redacted]:[redacted]@'
        )
        .replace(
            /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]{0,262144}?-----END \1-----/gi,
            '[redacted-private-key]'
        )
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
        .replace(
            /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gim,
            '$1[redacted]'
        )
        .replace(
            /((?:^|[\r\n])([ \t]*)["']?[A-Za-z0-9_.-]{0,80}(?:token|api[_-]?key|password|passwd|secret|authorization|proxy[_-]?authorization|cookie|set-cookie|private[_-]?key)[A-Za-z0-9_.-]{0,80}["']?\s*:\s*)[|>][-+]?[0-9]*[^\r\n]*(?:\r?\n\2[ \t]+[^\r\n]*)*/gim,
            '$1[redacted]'
        )
        .replace(
            /((?:^|[\s,{?&;])["']?[A-Za-z0-9_.-]{0,80}(?:token|api[_-]?key|password|passwd|secret|authorization|proxy[_-]?authorization|cookie|set-cookie|private[_-]?key)[A-Za-z0-9_.-]{0,80}["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/gim,
            '$1[redacted]'
        )
        .replace(
            /((?:^|[\r\n])[ \t]*["']?[A-Za-z0-9_.-]{0,80}(?:token|api[_-]?key|password|passwd|secret|authorization|proxy[_-]?authorization|cookie|set-cookie|private[_-]?key)[A-Za-z0-9_.-]{0,80}["']?\s*[:=]\s*)[^\r\n]*/gim,
            '$1[redacted]'
        )
        .replace(
            /((?:^|[\s,{?&;])["']?[A-Za-z0-9_.-]{0,80}(?:token|api[_-]?key|password|passwd|secret|authorization|proxy[_-]?authorization|cookie|set-cookie|private[_-]?key)[A-Za-z0-9_.-]{0,80}["']?\s*[:=]\s*)[^,}\r\n&;]*/gim,
            '$1[redacted]'
        )
        .replace(/((?:TOKEN|SECRET|PASSWORD|PASS|KEY)[A-Z0-9_]*=)[^\s"']+/gi, '$1[redacted]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
        .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted-openai-key]')
        .replace(/github_pat_[A-Za-z0-9_]{20,}/gi, '[redacted-github-token]')
        .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/gi, '[redacted-github-token]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
}

function truncateChangeDeskText(value, maxChars = CHANGE_DESK_OUTPUT_MAX_CHARS) {
    const text = redactSensitiveText(value);
    if (text.length <= maxChars) {
        return { text, truncated: false };
    }

    const notice = '\n...[output truncated]\n';
    const keep = Math.max(0, maxChars - notice.length);
    return {
        text: `${text.slice(0, keep)}${notice}`,
        truncated: true
    };
}

function redactStructuredValue(value, depth = 0) {
    if (depth > 12) {
        return '[nested data omitted]';
    }
    if (typeof value === 'string') {
        return redactSensitiveText(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactStructuredValue(item, depth + 1));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            redactSensitiveText(key),
            redactStructuredValue(item, depth + 1)
        ]));
    }
    return value;
}

function ensureChangeDeskReportDir() {
    fs.mkdirSync(CHANGE_DESK_REPORT_DIR, { recursive: true, mode: 0o700 });
}

function changeDeskReportFilename() {
    return `change-desk-report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
}

function writeChangeDeskReport(report) {
    const text = redactSensitiveText(report).trim();
    const truncated = text.length > CHANGE_DESK_REPORT_MAX_CHARS;
    const reportText = truncated
        ? `${text.slice(0, CHANGE_DESK_REPORT_MAX_CHARS)}\n\n...[report truncated]\n`
        : text;
    const content = [
        '# Change Desk Report',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Workspace: ${CONFIG_ROOT}`,
        '',
        reportText
    ].join('\n');
    const filePath = path.join(CHANGE_DESK_REPORT_DIR, changeDeskReportFilename());

    ensureChangeDeskReportDir();
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });

    return {
        path: filePath,
        bytes: Buffer.byteLength(content, 'utf8'),
        truncated
    };
}

function ensureMallCopMemoryDir() {
    fs.mkdirSync(path.dirname(CHANGE_DESK_MALL_COP_MEMORY_FILE), { recursive: true, mode: 0o700 });
}

function loadMallCopMemory() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CHANGE_DESK_MALL_COP_MEMORY_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function saveMallCopMemory(memory) {
    ensureMallCopMemoryDir();
    writeFileAtomic(
        CHANGE_DESK_MALL_COP_MEMORY_FILE,
        `${JSON.stringify(memory, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
    );
}

function mallCopMemoryGeneratedAt(memory) {
    return memory?.generatedAt || memory?.observation?.generatedAt || '';
}

function mallCopLastActivityAt(memory) {
    const candidates = [memory?.lastAttemptAt, mallCopMemoryGeneratedAt(memory)]
        .map((value) => Date.parse(value || ''))
        .filter(Number.isFinite);
    return candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : '';
}

function isMallCopAutoDue(memory, nowMs = Date.now()) {
    if (CHANGE_DESK_MALL_COP_AUTO_INTERVAL_SECONDS <= 0) {
        return false;
    }

    const generatedAt = Date.parse(mallCopLastActivityAt(memory));
    if (!Number.isFinite(generatedAt)) {
        return true;
    }

    return nowMs - generatedAt >= CHANGE_DESK_MALL_COP_AUTO_INTERVAL_SECONDS * 1000;
}

function mallCopNextRunAt(memory) {
    const generatedAt = Date.parse(mallCopLastActivityAt(memory));
    if (!Number.isFinite(generatedAt) || CHANGE_DESK_MALL_COP_AUTO_INTERVAL_SECONDS <= 0) {
        return '';
    }

    return new Date(generatedAt + CHANGE_DESK_MALL_COP_AUTO_INTERVAL_SECONDS * 1000).toISOString();
}

function mallCopObservationForClient(memory) {
    const observation = memory?.observation || {};
    if (!observation.summary) {
        return null;
    }

    return {
        success: true,
        generatedAt: memory.generatedAt || observation.generatedAt || '',
        durationMs: Number.isFinite(observation.durationMs) ? observation.durationMs : 0,
        summary: redactSensitiveText(observation.summary).slice(0, CHANGE_DESK_MALL_COP_MAX_CHARS),
        packetPath: memory.packetPath || '',
        packetTruncated: Boolean(memory.packetTruncated || observation.truncated),
        trigger: memory.trigger || 'unknown',
        comparison: memory.comparison || null
    };
}

function buildMallCopState(memory) {
    const generatedAt = mallCopMemoryGeneratedAt(memory);
    const generatedAtMs = Date.parse(generatedAt);
    const ageSeconds = Number.isFinite(generatedAtMs)
        ? Math.max(0, Math.round((Date.now() - generatedAtMs) / 1000))
        : null;

    return {
        available: Boolean(memory?.observation?.summary),
        path: CHANGE_DESK_MALL_COP_MEMORY_FILE,
        generatedAt,
        ageSeconds,
        due: isMallCopAutoDue(memory),
        nextRunAt: mallCopNextRunAt(memory),
        autoIntervalSeconds: CHANGE_DESK_MALL_COP_AUTO_INTERVAL_SECONDS,
        latestObservation: mallCopObservationForClient(memory),
        comparison: memory?.comparison || null
    };
}

function issueDigestLabel(issue) {
    const classification = issue?.classification || {};
    return classification.label || issue?.sample || issue?.key || 'issue';
}

function buildMallCopDigest(snapshot) {
    const monitor = snapshot.monitor || {};
    const issues = new Map();
    const addIssue = (issue, kind) => {
        if (!issue) {
            return;
        }

        const key = issue.key || `${issue.source || 'unknown'}:${issue.sample || ''}`.slice(0, 220);
        const existing = issues.get(key) || {
            key,
            label: issueDigestLabel(issue),
            source: issue.source || 'unknown',
            severity: issue.severity || 'warning',
            sample: redactSensitiveText(issue.sample || '').slice(0, 300),
            runsSeen: Number(issue.runsSeen || 0),
            occurrences: Number(issue.occurrences || 0),
            currentCount: Number(issue.currentCount || 0),
            firstSeen: issue.firstSeen || '',
            lastSeen: issue.lastSeen || '',
            category: issue.classification?.category || '',
            posture: issue.classification?.posture || '',
            active: false,
            persistent: false
        };
        existing.active = existing.active || kind === 'current';
        existing.persistent = existing.persistent || kind === 'persistent';
        existing.runsSeen = Math.max(existing.runsSeen, Number(issue.runsSeen || 0));
        existing.occurrences = Math.max(existing.occurrences, Number(issue.occurrences || 0));
        existing.currentCount = Math.max(existing.currentCount, Number(issue.currentCount || 0));
        existing.firstSeen = earlierIso(existing.firstSeen, issue.firstSeen || '');
        existing.lastSeen = laterIso(existing.lastSeen, issue.lastSeen || '');
        issues.set(key, existing);
    };

    (monitor.currentIssues || []).forEach((issue) => addIssue(issue, 'current'));
    (monitor.persistentIssues || []).forEach((issue) => addIssue(issue, 'persistent'));

    return {
        generatedAt: snapshot.generatedAt || '',
        monitorGeneratedAt: monitor.generatedAt || '',
        monitorStatus: monitor.status || 'unavailable',
        dispatchFingerprint: monitor.dispatch?.reasoningGate?.deltaFingerprint || '',
        configChanged: monitor.dispatch?.delta?.configChanged,
        currentIssueCount: (monitor.currentIssues || []).length,
        persistentIssueCount: (monitor.persistentIssues || []).length,
        issues: [...issues.values()]
            .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.persistent) - Number(a.persistent) || b.runsSeen - a.runsSeen)
            .slice(0, 30),
        conditions: (monitor.conditions || []).slice(0, 12).map((condition) => ({
            key: condition.key || '',
            label: condition.label || '',
            category: condition.category || '',
            posture: condition.posture || '',
            trajectory: condition.trajectory || '',
            activeCount: Number(condition.activeCount || 0),
            chronicCount: Number(condition.chronicCount || 0),
            issueCount: Number(condition.issueCount || 0),
            totalRuns: Number(condition.totalRuns || 0),
            totalOccurrences: Number(condition.totalOccurrences || 0),
            lastSeen: condition.lastSeen || ''
        }))
    };
}

function describeMallCopIssueChange(previous, current) {
    const changes = [];
    if (previous.active !== current.active) {
        changes.push(current.active ? 'became active again' : 'went quiet');
    }
    if (previous.persistent !== current.persistent) {
        changes.push(current.persistent ? 'became persistent' : 'no longer marked persistent');
    }
    if (previous.severity !== current.severity) {
        changes.push(`severity ${previous.severity || 'unknown'} -> ${current.severity || 'unknown'}`);
    }
    if (previous.posture !== current.posture || previous.category !== current.category) {
        changes.push(`classification ${previous.category || 'unknown'}/${previous.posture || 'unknown'} -> ${current.category || 'unknown'}/${current.posture || 'unknown'}`);
    }
    if (current.currentCount !== previous.currentCount) {
        changes.push(`current count ${previous.currentCount || 0} -> ${current.currentCount || 0}`);
    }
    if (current.runsSeen !== previous.runsSeen) {
        changes.push(`runs seen ${previous.runsSeen || 0} -> ${current.runsSeen || 0}`);
    }
    if (current.occurrences !== previous.occurrences) {
        changes.push(`occurrences ${previous.occurrences || 0} -> ${current.occurrences || 0}`);
    }
    if (previous.sample && current.sample && previous.sample !== current.sample) {
        changes.push('representative sample changed');
    }

    return changes.join('; ') || 'no material change';
}

function buildMallCopMemoryComparison(currentDigest, previousDigest) {
    const previousIssues = new Map((previousDigest?.issues || []).map((issue) => [issue.key, issue]));
    const currentIssues = new Map((currentDigest?.issues || []).map((issue) => [issue.key, issue]));
    const newIssues = [];
    const resolvedIssues = [];
    const changedIssues = [];
    const unchangedIssues = [];

    for (const issue of currentIssues.values()) {
        const previous = previousIssues.get(issue.key);
        if (!previous) {
            newIssues.push(issue);
            continue;
        }

        const change = describeMallCopIssueChange(previous, issue);
        if (change === 'no material change') {
            unchangedIssues.push(issue);
        } else {
            changedIssues.push({ ...issue, change });
        }
    }

    for (const issue of previousIssues.values()) {
        if (!currentIssues.has(issue.key)) {
            resolvedIssues.push(issue);
        }
    }

    return {
        comparedWith: previousDigest?.generatedAt || '',
        currentGeneratedAt: currentDigest?.generatedAt || '',
        newIssues: newIssues.slice(0, 8),
        resolvedIssues: resolvedIssues.slice(0, 8),
        changedIssues: changedIssues.slice(0, 8),
        unchangedIssues: unchangedIssues.slice(0, 8)
    };
}

function summarizeMallCopIssue(issue) {
    const state = [
        issue.active ? 'active' : 'quiet',
        issue.persistent ? 'persistent' : 'not persistent',
        issue.runsSeen ? `${issue.runsSeen} runs` : '',
        issue.occurrences ? `${issue.occurrences} occurrences` : ''
    ].filter(Boolean).join(', ');
    return `${issue.label || issue.key || 'issue'} (${state || issue.source || 'unknown'})`;
}

function appendMallCopIssueList(lines, label, issues, formatter = summarizeMallCopIssue) {
    lines.push(`${label}: ${issues.length}`);
    if (!issues.length) {
        return;
    }

    issues.slice(0, 6).forEach((issue) => {
        lines.push(`- ${formatter(issue)}`);
    });
}

function buildMallCopMemoryLines(previousMemory, currentDigest) {
    const comparison = buildMallCopMemoryComparison(currentDigest, previousMemory?.digest);
    const lines = [
        '## Mall Cop Memory',
        `Memory file: ${CHANGE_DESK_MALL_COP_MEMORY_FILE}`,
        `Previous Mall Cop run: ${mallCopMemoryGeneratedAt(previousMemory) || 'none'}`,
        `Next automatic run due: ${mallCopNextRunAt(previousMemory) || 'now'}`,
        `Compared current snapshot with previous memory: ${comparison.comparedWith || 'no previous memory'}`
    ];

    appendMallCopIssueList(lines, 'New since previous Mall Cop run', comparison.newIssues);
    appendMallCopIssueList(lines, 'Resolved since previous Mall Cop run', comparison.resolvedIssues);
    appendMallCopIssueList(
        lines,
        'Persisting with changes',
        comparison.changedIssues,
        (issue) => `${summarizeMallCopIssue(issue)}: ${issue.change}`
    );
    appendMallCopIssueList(lines, 'Persisting with no material change', comparison.unchangedIssues);

    const previousSummary = previousMemory?.observation?.summary
        ? redactSensitiveText(previousMemory.observation.summary).slice(0, 1200)
        : '';
    if (previousSummary) {
        lines.push('', 'Previous Mall Cop bottom-line context:', previousSummary);
    }

    return { lines, comparison };
}

function buildMallCopMemoryRecord(snapshot, observation, report, previousMemory, trigger) {
    const digest = buildMallCopDigest(snapshot);
    const generatedAt = new Date().toISOString();
    return {
        version: 1,
        generatedAt,
        lastAttemptAt: generatedAt,
        lastAttempt: {
            generatedAt,
            trigger,
            success: true,
            timedOut: false,
            durationMs: Number.isFinite(observation.durationMs) ? observation.durationMs : 0,
            exitCode: observation.exitCode
        },
        trigger,
        packetPath: report.path,
        packetTruncated: Boolean(report.truncated),
        previousGeneratedAt: mallCopMemoryGeneratedAt(previousMemory),
        observation: {
            generatedAt: new Date().toISOString(),
            durationMs: Number.isFinite(observation.durationMs) ? observation.durationMs : 0,
            summary: redactSensitiveText(observation.summary || '').slice(0, CHANGE_DESK_MALL_COP_MAX_CHARS),
            truncated: Boolean(observation.truncated),
            exitCode: observation.exitCode
        },
        digest,
        comparison: buildMallCopMemoryComparison(digest, previousMemory?.digest)
    };
}

function buildFailedMallCopAttempt(previousMemory, observation, report, trigger) {
    const generatedAt = new Date().toISOString();
    return {
        ...(previousMemory || { version: 1 }),
        lastAttemptAt: generatedAt,
        lastAttempt: {
            generatedAt,
            trigger,
            success: false,
            timedOut: Boolean(observation.timedOut),
            durationMs: Number.isFinite(observation.durationMs) ? observation.durationMs : 0,
            exitCode: observation.exitCode,
            packetPath: report.path
        }
    };
}

function runChangeDeskCommand(command, args, options = {}) {
    const timeout = options.timeout || CHANGE_DESK_COMMAND_TIMEOUT_MS;
    const maxChars = options.maxChars || CHANGE_DESK_OUTPUT_MAX_CHARS;

    return new Promise((resolve) => {
        execFile(command, args, {
            cwd: CONFIG_ROOT,
            timeout,
            maxBuffer: 1024 * 1024
        }, (err, stdout = '', stderr = '') => {
            let parsedJson = null;
            if (options.parseJson) {
                try {
                    parsedJson = JSON.parse(stdout || '{}');
                } catch {
                    parsedJson = null;
                }
            }
            const stdoutResult = truncateChangeDeskText(stdout, maxChars);
            const stderrResult = truncateChangeDeskText(stderr, maxChars);
            const combinedResult = truncateChangeDeskText(
                [stdoutResult.text, stderrResult.text].filter(Boolean).join('\n'),
                maxChars
            );
            const exitCode = err && Number.isInteger(err.code) ? err.code : (err ? null : 0);

            resolve({
                success: !err,
                command,
                args,
                exitCode,
                stdout: stdoutResult.text,
                stderr: stderrResult.text,
                output: combinedResult.text,
                truncated: stdoutResult.truncated || stderrResult.truncated || combinedResult.truncated,
                timedOut: Boolean(err?.killed || err?.signal === 'SIGTERM'),
                notFound: err?.code === 'ENOENT',
                error: err ? redactSensitiveText(err.message) : '',
                parsedJson
            });
        });
    });
}

async function collectChangeDeskAudit() {
    const result = await runChangeDeskCommand('ha-toolbox', [
        'audit-config',
        '--config',
        CONFIG_ROOT,
        '--json',
        '--max-files',
        '500'
    ], {
        timeout: CHANGE_DESK_COMMAND_TIMEOUT_MS,
        maxChars: CHANGE_DESK_OUTPUT_MAX_CHARS,
        parseJson: true
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            message: 'ha-toolbox is not available'
        };
    }

    const parsed = result.parsedJson ? redactStructuredValue(result.parsedJson) : null;

    if (!parsed) {
        return {
            available: false,
            status: 'unavailable',
            exitCode: result.exitCode,
            output: result.output || result.error || 'ha-toolbox audit did not return JSON'
        };
    }

    const yamlErrors = Array.isArray(parsed.yaml?.errors) ? parsed.yaml.errors : [];
    return {
        available: true,
        status: result.success ? 'passed' : 'failed',
        exitCode: result.exitCode,
        config: parsed.config || CONFIG_ROOT,
        exists: Boolean(parsed.exists),
        yaml: {
            checked: parsed.yaml?.checked || 0,
            ok: parsed.yaml?.ok || 0,
            errors: yamlErrors.slice(0, 20),
            errorCount: yamlErrors.length
        },
        counts: parsed.counts || {},
        customComponents: Array.isArray(parsed.custom_components)
            ? parsed.custom_components.slice(0, 80)
            : [],
        expectedPaths: parsed.expected_paths || {},
        rootKeys: parsed.root_keys || {},
        truncated: result.truncated
    };
}

async function collectChangeDeskCoreCheck() {
    const result = await runChangeDeskCommand('ha', ['core', 'check'], {
        timeout: CHANGE_DESK_COMMAND_TIMEOUT_MS,
        maxChars: CHANGE_DESK_OUTPUT_MAX_CHARS
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            command: 'ha core check',
            message: 'Home Assistant CLI is not available'
        };
    }

    return {
        available: true,
        status: result.success ? 'passed' : 'failed',
        command: 'ha core check',
        exitCode: result.exitCode,
        output: result.output,
        timedOut: result.timedOut,
        truncated: result.truncated
    };
}

function severityFromLogLine(line) {
    const text = String(line || '');
    if (/\b(CRITICAL|FATAL)\b/i.test(text)) {
        return 'critical';
    }
    if (/\b(ERROR|ERR)\b/i.test(text) || /Traceback|Exception|failed/i.test(text)) {
        return 'error';
    }
    if (/\b(WARNING|WARN)\b/i.test(text)) {
        return 'warning';
    }
    return '';
}

function normalizeLogSignature(line) {
    return String(line || '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?\s*/g, '')
        .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
        .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
}

const CONNECTIVITY_RE = /\b(modbus|pymodbus|minimalmodbus|rtu|wifi|wi-fi|wlan|brcmf|escan|timeout|timed out|read timed out|socket timeout|scan timeout|no response|not responding|unreachable|host is down|network is unreachable|connection (?:reset|refused|aborted|closed|lost|timeout)|connect(?:ion)? failed|cannot connect|can't connect|disconnected|gateway timeout|i\/o error|ioerror|broken pipe|transaction id|mismatched transaction|request failed after)\b/i;
const STRONG_CONFIG_RE = /\b(invalid (?:config|configuration|yaml|option)|configuration (?:invalid|error)|yaml|while parsing|mapping values|expected (?:<block end>|key)|not a valid value|integration not found|platform error|component error|schema validation|deprecated option|breaking change)\b/i;
const WEAK_CONFIG_RE = /\b(config entry|setup failed|failed to set up|could not set up|integration setup)\b/i;
const AUTH_RE = /\b(unauthorized|forbidden|authentication failed|invalid auth|token expired|invalid token|login required|reauthentication required|credentials? (?:invalid|expired)|permission denied)\b/i;
const SYSTEMIC_RE = /\b(no space left|disk full|out of memory|database is locked|home assistant (?:failed to start|crashed|stopped)|recorder.*(?:failed|corrupt|locked)|supervisor.*unhealthy|watchdog|event loop blocked)\b/i;
const CRITICAL_ENTITY_RE = /\b(alarm|security|lock|door lock|garage|smoke|carbon monoxide|\bco\b|leak|water leak|flood|siren|valve|shutoff|medical|critical)\b|\b(?:alarm_control_panel|lock)\.|\b(?:binary_sensor|sensor)\.[a-z0-9_]*(?:smoke|carbon_monoxide|co_|leak|flood)|\bcover\.[a-z0-9_]*(?:garage|door)/i;

function issueText(issue) {
    return [
        issue?.key,
        issue?.source,
        issue?.signature,
        issue?.sample
    ].filter(Boolean).join(' ');
}

function classifyChangeDeskIssue(issue) {
    const text = issueText(issue);
    const source = String(issue?.source || '');
    const criticalCandidate = CRITICAL_ENTITY_RE.test(text);

    if (SYSTEMIC_RE.test(text)) {
        return {
            category: 'systemic',
            label: 'system-wide risk',
            posture: 'systemic_risk',
            impact: 'could affect Home Assistant broadly',
            codexActionability: 'review core health before config or reload work',
            configBlocker: true,
            systemWideRisk: 'high',
            requiresHumanPriorityCheck: true,
            confidence: 'medium'
        };
    }

    if (AUTH_RE.test(text)) {
        return {
            category: 'auth',
            label: 'auth or permission issue',
            posture: 'needs_account_or_token_attention',
            impact: 'localized to the integration unless shared credentials are involved',
            codexActionability: 'Codex can inspect config, but account or token repair may need a human',
            configBlocker: false,
            systemWideRisk: 'medium',
            requiresHumanPriorityCheck: criticalCandidate,
            confidence: 'medium'
        };
    }

    if (STRONG_CONFIG_RE.test(text)) {
        return {
            category: 'configuration',
            label: 'configuration blocker',
            posture: 'config_review_needed',
            impact: 'may block reload, setup, or integration startup',
            codexActionability: 'Codex should inspect YAML, storage, or integration setup before changes',
            configBlocker: true,
            systemWideRisk: 'medium',
            requiresHumanPriorityCheck: criticalCandidate,
            confidence: 'medium'
        };
    }

    if (CONNECTIVITY_RE.test(text)) {
        return {
            category: 'noisy_connectivity',
            label: 'localized connectivity noise',
            posture: 'localized_connectivity_noise',
            impact: criticalCandidate
                ? 'potentially critical entity; confirm priority before treating as low risk'
                : 'localized device or link failure, low system-wide risk',
            codexActionability: 'not fixable from Home Assistant config alone; inspect network/device health if it matters',
            configBlocker: false,
            systemWideRisk: criticalCandidate ? 'needs_human_priority_check' : 'low_unless_critical',
            requiresHumanPriorityCheck: criticalCandidate,
            confidence: 'medium'
        };
    }

    if (source === 'states') {
        return {
            category: 'entity_availability',
            label: 'entity unavailable',
            posture: 'localized_entity_availability',
            impact: criticalCandidate
                ? 'potentially critical entity; confirm priority before treating as low risk'
                : 'localized entity state issue, low system-wide risk',
            codexActionability: 'inspect entity history, device reachability, and site notes before changing config',
            configBlocker: false,
            systemWideRisk: criticalCandidate ? 'needs_human_priority_check' : 'low_unless_critical',
            requiresHumanPriorityCheck: criticalCandidate,
            confidence: criticalCandidate ? 'low' : 'medium'
        };
    }

    if (WEAK_CONFIG_RE.test(text)) {
        return {
            category: 'configuration',
            label: 'possible setup/config issue',
            posture: 'config_review_needed',
            impact: 'may be integration setup or configuration-related',
            codexActionability: 'Codex should inspect setup evidence before recommending reloads',
            configBlocker: true,
            systemWideRisk: 'medium',
            requiresHumanPriorityCheck: criticalCandidate,
            confidence: 'low'
        };
    }

    return {
        category: 'unknown',
        label: 'needs review',
        posture: 'needs_review',
        impact: 'unknown until reviewed with current HA context',
        codexActionability: 'review logs and live entity context before acting',
        configBlocker: false,
        systemWideRisk: 'unknown',
        requiresHumanPriorityCheck: criticalCandidate,
        confidence: 'low'
    };
}

function normalizeIssueClassification(classification, issue) {
    const classified = classification && typeof classification === 'object'
        ? classification
        : classifyChangeDeskIssue(issue || {});
    return {
        category: classified.category || 'unknown',
        label: classified.label || 'needs review',
        posture: classified.posture || 'needs_review',
        impact: classified.impact || '',
        codexActionability: classified.codex_actionability || classified.codexActionability || '',
        configBlocker: Boolean(classified.config_blocker ?? classified.configBlocker),
        systemWideRisk: classified.system_wide_risk || classified.systemWideRisk || 'unknown',
        requiresHumanPriorityCheck: Boolean(classified.requires_human_priority_check ?? classified.requiresHumanPriorityCheck),
        confidence: classified.confidence || 'low'
    };
}

function issueWithClassification(issue) {
    const updated = { ...issue };
    updated.classification = normalizeIssueClassification(updated.classification, updated);
    return updated;
}

function isLowRiskLocalNoise(issue) {
    const classification = normalizeIssueClassification(issue?.classification, issue);
    return issue?.severity !== 'critical'
        && ['noisy_connectivity', 'entity_availability'].includes(classification.category)
        && !classification.configBlocker
        && !classification.requiresHumanPriorityCheck
        && String(classification.systemWideRisk || '').startsWith('low');
}

function isHardErrorIssue(issue) {
    return ['critical', 'error'].includes(issue?.severity) && !isLowRiskLocalNoise(issue);
}

function deriveLogStatus(counts, issues) {
    if ((counts?.critical || 0) > 0 || (counts?.error || 0) > 0) {
        if (issues?.length && !issues.some(isHardErrorIssue)) {
            return 'warning';
        }
        return 'error';
    }
    return (counts?.warning || 0) > 0 ? 'warning' : 'clean';
}

function summarizeLogIssues(output) {
    const lines = String(output || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(-CHANGE_DESK_LOG_LINE_LIMIT);
    const issueMap = new Map();
    const counts = {
        critical: 0,
        error: 0,
        warning: 0
    };

    for (const line of lines) {
        const severity = severityFromLogLine(line);
        if (!severity) {
            continue;
        }

        counts[severity] += 1;
        const signature = normalizeLogSignature(line);
        if (!signature) {
            continue;
        }

        const existing = issueMap.get(signature) || {
            signature,
            severity,
            count: 0,
            sample: line
        };
        existing.count += 1;
        if (severity === 'critical' || (severity === 'error' && existing.severity === 'warning')) {
            existing.severity = severity;
        }
        issueMap.set(signature, existing);
    }

    const issues = Array.from(issueMap.values())
        .sort((a, b) => {
            const severityRank = { critical: 3, error: 2, warning: 1 };
            return (severityRank[b.severity] - severityRank[a.severity]) || (b.count - a.count);
        })
        .slice(0, 12)
        .map((issue) => issueWithClassification({ ...issue, source: 'logs' }));
    const repeated = issues.filter((issue) => issue.count >= 3).slice(0, 8);

    return {
        scannedLines: lines.length,
        counts,
        issues,
        repeated
    };
}

async function collectChangeDeskLogs() {
    const result = await runChangeDeskCommand('ha', ['core', 'logs'], {
        timeout: CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS,
        maxChars: CHANGE_DESK_LOG_OUTPUT_MAX_CHARS
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            command: 'ha core logs',
            message: 'Home Assistant CLI is not available'
        };
    }

    if (!result.success && !result.stdout) {
        return {
            available: false,
            status: 'unavailable',
            command: 'ha core logs',
            exitCode: result.exitCode,
            output: result.output || result.error || 'Home Assistant logs unavailable',
            timedOut: result.timedOut,
            truncated: result.truncated
        };
    }

    const summary = summarizeLogIssues(result.stdout || result.output);
    const status = deriveLogStatus(summary.counts, summary.issues);

    return {
        available: true,
        status,
        command: 'ha core logs',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        scannedLines: summary.scannedLines,
        counts: summary.counts,
        issues: summary.issues,
        repeated: summary.repeated
    };
}

async function collectChangeDeskLive() {
    const result = await runChangeDeskCommand('ha-api', ['config'], {
        timeout: CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS,
        maxChars: CHANGE_DESK_OUTPUT_MAX_CHARS,
        parseJson: true
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            message: 'ha-api is not available'
        };
    }

    const parsed = result.parsedJson ? redactStructuredValue(result.parsedJson) : null;

    if (!result.success || !parsed) {
        return {
            available: false,
            status: 'unavailable',
            exitCode: result.exitCode,
            output: result.output || result.error || 'ha-api config did not return JSON'
        };
    }

    return {
        available: true,
        status: 'available',
        config: {
            locationName: parsed.location_name || '',
            version: parsed.version || '',
            timeZone: parsed.time_zone || '',
            unitSystem: parsed.unit_system?.name || parsed.unit_system || '',
            components: Array.isArray(parsed.components) ? parsed.components.length : null
        }
    };
}

async function collectChangeDeskMcp() {
    const result = await runChangeDeskCommand('ha-mcp-status', ['--json'], {
        timeout: CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS,
        maxChars: CHANGE_DESK_OUTPUT_MAX_CHARS,
        parseJson: true
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            message: 'ha-mcp-status is not available'
        };
    }

    const parsed = result.parsedJson ? redactStructuredValue(result.parsedJson) : null;

    if (!result.success || !parsed) {
        return {
            available: false,
            status: 'unavailable',
            exitCode: result.exitCode,
            output: result.output || result.error || 'ha-mcp-status did not return JSON'
        };
    }

    return {
        available: true,
        status: parsed.component_loaded ? 'loaded' : 'not_loaded',
        componentLoaded: Boolean(parsed.component_loaded),
        internalEndpoint: parsed.internal_endpoint || '',
        externalPath: parsed.external_path || ''
    };
}

function normalizeMonitorIssue(issue) {
    const sample = redactSensitiveText(issue?.sample || issue?.signature || '');
    const normalized = {
        key: issue?.key || '',
        source: issue?.source || 'unknown',
        severity: issue?.severity || 'warning',
        sample: sample.slice(0, 500),
        runsSeen: Number.isInteger(issue?.runs_seen) ? issue.runs_seen : 0,
        occurrences: Number.isInteger(issue?.occurrences) ? issue.occurrences : (Number.isInteger(issue?.count) ? issue.count : 0),
        currentCount: Number.isInteger(issue?.current_count) ? issue.current_count : (Number.isInteger(issue?.count) ? issue.count : 0),
        firstSeen: issue?.first_seen || '',
        lastSeen: issue?.last_seen || ''
    };
    normalized.classification = normalizeIssueClassification(issue?.classification, normalized);
    return normalized;
}

function normalizeMonitorTriage(triage) {
    const categoryCounts = triage?.category_counts || {};
    const postureCounts = triage?.posture_counts || {};
    return {
        dominantPosture: triage?.dominant_posture || 'unknown',
        issueCount: Number.isInteger(triage?.issue_count) ? triage.issue_count : 0,
        localizedNoiseCount: Number.isInteger(triage?.localized_noise_count) ? triage.localized_noise_count : 0,
        configBlockerCount: Number.isInteger(triage?.config_blocker_count) ? triage.config_blocker_count : 0,
        priorityCheckCount: Number.isInteger(triage?.priority_check_count) ? triage.priority_check_count : 0,
        hardIssueCount: Number.isInteger(triage?.hard_issue_count) ? triage.hard_issue_count : 0,
        lowRiskOnly: Boolean(triage?.low_risk_only),
        categoryCounts,
        postureCounts,
        summaryLines: Array.isArray(triage?.summary_lines)
            ? triage.summary_lines.map((line) => redactSensitiveText(String(line)).slice(0, 500))
            : []
    };
}

function normalizeMonitorDispatch(dispatch) {
    const delta = dispatch?.delta || {};
    const gate = dispatch?.reasoning_gate || {};
    const lines = Array.isArray(delta.summary_lines)
        ? delta.summary_lines.map((line) => redactSensitiveText(String(line)).slice(0, 500))
        : [];

    return {
        available: Boolean(dispatch),
        status: dispatch?.status || 'quiet',
        meaningfulDelta: Boolean(dispatch?.meaningful_delta || delta.meaningful),
        generatedAt: dispatch?.generated_at || '',
        text: redactSensitiveText(dispatch?.text || '').slice(0, 12000),
        truncated: Boolean(dispatch?.truncated),
        delta: {
            since: delta.since || '',
            statusChanged: Boolean(delta.status_changed),
            previousStatus: delta.previous_status || '',
            currentStatus: delta.current_status || '',
            triage: normalizeMonitorTriage(delta.triage || {}),
            configChanged: delta.config_changed,
            summaryLines: lines,
            newIssues: (delta.new_issues || []).slice(0, 6).map(normalizeMonitorIssue),
            resolvedIssues: (delta.resolved_issues || []).slice(0, 6).map(normalizeMonitorIssue),
            newlyPersistentIssues: (delta.newly_persistent_issues || []).slice(0, 6).map(normalizeMonitorIssue),
            continuingIssueCount: Number.isInteger(delta.continuing_issue_count) ? delta.continuing_issue_count : 0,
            persistentIssueCount: Number.isInteger(delta.persistent_issue_count) ? delta.persistent_issue_count : 0
        },
        reasoningGate: {
            automaticLlmCalls: Boolean(gate.automatic_llm_calls),
            lowReasoningEligible: Boolean(gate.low_reasoning_eligible),
            lowReasoningIntervalSeconds: Number.isInteger(gate.low_reasoning_interval_seconds) ? gate.low_reasoning_interval_seconds : null,
            lowReasoningCooldownSeconds: Number.isInteger(gate.low_reasoning_cooldown_seconds) ? gate.low_reasoning_cooldown_seconds : null,
            maxScheduledLlmCallsPerDay: Number.isInteger(gate.max_scheduled_llm_calls_per_day) ? gate.max_scheduled_llm_calls_per_day : null,
            maxDispatchChars: Number.isInteger(gate.max_dispatch_chars) ? gate.max_dispatch_chars : null,
            deltaFingerprint: gate.delta_fingerprint || '',
            deterministicPosture: gate.deterministic_posture || 'unknown',
            deterministicLowRiskOnly: Boolean(gate.deterministic_low_risk_only),
            sameFingerprintAsPrevious: Boolean(gate.same_fingerprint_as_previous),
            cooldownRemainingSeconds: Number.isInteger(gate.cooldown_remaining_seconds) ? gate.cooldown_remaining_seconds : 0,
            highReasoningRequiresUserAction: gate.high_reasoning_requires_user_action !== false,
            noCallReason: gate.no_call_reason || '',
            policy: gate.policy || ''
        }
    };
}

function loadChangeDeskDispatch(fallbackDispatch) {
    try {
        return normalizeMonitorDispatch(JSON.parse(fs.readFileSync(CHANGE_DESK_DISPATCH_FILE, 'utf8')));
    } catch {
        return normalizeMonitorDispatch(fallbackDispatch || null);
    }
}

function loadMonitorHistory(limit = 48) {
    try {
        return parseJsonLinesTail(HA_MONITOR_HISTORY_FILE, {
            limit,
            maxBytes: HA_MONITOR_HISTORY_READ_MAX_BYTES
        });
    } catch {
        return [];
    }
}

function countBy(items, pickValue) {
    const counts = {};
    for (const item of items || []) {
        const value = pickValue(item);
        if (!value) {
            continue;
        }
        counts[value] = (counts[value] || 0) + 1;
    }
    return counts;
}

function numericSeries(items, key) {
    return (items || [])
        .map((item) => Number(item?.[key]))
        .filter((value) => Number.isFinite(value));
}

function seriesDirection(values) {
    if (!values.length) {
        return 'unknown';
    }

    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    if (delta >= 3) {
        return 'worsening';
    }
    if (delta <= -3) {
        return 'improving';
    }
    return 'stable';
}

function summarizeMonitorHistory(history) {
    const recent = history.slice(-12);
    const currentSeries = numericSeries(recent, 'current_issues');
    const persistentSeries = numericSeries(recent, 'persistent_issues');
    const first = history[0] || {};
    const last = history[history.length - 1] || {};
    const logErrorSeries = recent.map((entry) => {
        const counts = entry?.log_counts || {};
        return Number(counts.critical || 0) + Number(counts.error || 0);
    }).filter((value) => Number.isFinite(value));

    return {
        samples: history.length,
        firstSeen: first.generated_at || '',
        lastSeen: last.generated_at || '',
        statusCounts: countBy(history, (entry) => entry.status || 'unknown'),
        postureCounts: countBy(history, (entry) => entry.triage_posture || 'unknown'),
        meaningfulDeltas: history.filter((entry) => entry.meaningful_delta).length,
        configChanges: history.filter((entry) => entry.config_changed === true).length,
        recentCurrentIssues: currentSeries,
        recentPersistentIssues: persistentSeries,
        currentIssueDirection: seriesDirection(currentSeries),
        persistentIssueDirection: seriesDirection(persistentSeries),
        logErrorDirection: seriesDirection(logErrorSeries)
    };
}

function conditionGroupKey(issue) {
    const classification = issue?.classification || {};
    return [
        classification.posture || 'needs_review',
        classification.category || 'unknown',
        issue?.source || 'unknown'
    ].join(':');
}

function buildConditionLedger(monitor, historySummary) {
    const issueMap = new Map();
    for (const issue of [...(monitor.currentIssues || []), ...(monitor.persistentIssues || [])]) {
        if (!issue?.key) {
            continue;
        }
        const existing = issueMap.get(issue.key) || {};
        issueMap.set(issue.key, { ...existing, ...issue });
    }

    const groups = new Map();
    for (const issue of issueMap.values()) {
        const classification = issue.classification || {};
        const key = conditionGroupKey(issue);
        const group = groups.get(key) || {
            key,
            label: classification.label || classification.posture || 'needs review',
            category: classification.category || 'unknown',
            posture: classification.posture || 'needs_review',
            source: issue.source || 'unknown',
            impact: classification.impact || '',
            codexActionability: classification.codexActionability || '',
            systemWideRisk: classification.systemWideRisk || '',
            configBlocker: Boolean(classification.configBlocker),
            requiresHumanPriorityCheck: Boolean(classification.requiresHumanPriorityCheck),
            issueCount: 0,
            activeCount: 0,
            chronicCount: 0,
            totalRuns: 0,
            totalOccurrences: 0,
            firstSeen: '',
            lastSeen: '',
            samples: []
        };

        const runsSeen = Number(issue.runsSeen || 0);
        const occurrences = Number(issue.occurrences || 0);
        const active = Number(issue.currentCount || 0) > 0 || (monitor.currentIssues || []).some((current) => current.key === issue.key);
        group.issueCount += 1;
        group.activeCount += active ? 1 : 0;
        group.chronicCount += runsSeen >= 3 || occurrences >= 5 ? 1 : 0;
        group.totalRuns += Number.isFinite(runsSeen) ? runsSeen : 0;
        group.totalOccurrences += Number.isFinite(occurrences) ? occurrences : 0;
        group.firstSeen = earlierIso(group.firstSeen, issue.firstSeen);
        group.lastSeen = laterIso(group.lastSeen, issue.lastSeen);
        group.samples.push({
            severity: issue.severity || 'warning',
            runsSeen,
            occurrences,
            active,
            firstSeen: issue.firstSeen || '',
            lastSeen: issue.lastSeen || '',
            sample: redactSensitiveText(issue.sample || '').slice(0, 500)
        });
        groups.set(key, group);
    }

    const conditions = [...groups.values()].map((group) => {
        let trajectory = 'stable chronic';
        if (group.activeCount === 0) {
            trajectory = 'quiet recently';
        } else if (group.chronicCount === 0) {
            trajectory = 'new or intermittent';
        } else if (historySummary.currentIssueDirection === 'worsening' || historySummary.logErrorDirection === 'worsening') {
            trajectory = 'worsening';
        } else if (historySummary.currentIssueDirection === 'improving' && group.chronicCount > 0) {
            trajectory = 'improving but recurring';
        }

        return {
            ...group,
            trajectory,
            samples: group.samples
                .sort((a, b) => (b.runsSeen + b.occurrences) - (a.runsSeen + a.occurrences))
                .slice(0, 5)
        };
    });

    return conditions.sort((a, b) => {
        const priorityA = (a.configBlocker ? 100 : 0) + (a.requiresHumanPriorityCheck ? 50 : 0) + a.chronicCount + a.activeCount;
        const priorityB = (b.configBlocker ? 100 : 0) + (b.requiresHumanPriorityCheck ? 50 : 0) + b.chronicCount + b.activeCount;
        return priorityB - priorityA;
    }).slice(0, 12);
}

function earlierIso(left, right) {
    if (!left) {
        return right || '';
    }
    if (!right) {
        return left;
    }
    return Date.parse(right) < Date.parse(left) ? right : left;
}

function laterIso(left, right) {
    if (!left) {
        return right || '';
    }
    if (!right) {
        return left;
    }
    return Date.parse(right) > Date.parse(left) ? right : left;
}

function collectChangeDeskMonitor() {
    let parsed;
    let stat;

    try {
        stat = fs.statSync(HA_MONITOR_STATE_FILE);
        parsed = JSON.parse(fs.readFileSync(HA_MONITOR_STATE_FILE, 'utf8'));
    } catch (err) {
        return {
            available: false,
            status: 'unavailable',
            path: HA_MONITOR_STATE_FILE,
            message: err?.code === 'ENOENT' ? 'HA monitor has not written a state file yet' : redactSensitiveText(err.message)
        };
    }

    const generatedAtMs = Date.parse(parsed.generated_at || '');
    const ageSeconds = Number.isFinite(generatedAtMs) ? Math.max(0, Math.round((Date.now() - generatedAtMs) / 1000)) : null;
    const intervalSeconds = Number.isFinite(parsed.interval_seconds) ? parsed.interval_seconds : 300;
    const staleAfterSeconds = Math.max(900, intervalSeconds * 3);
    const stale = ageSeconds !== null && ageSeconds > staleAfterSeconds;
    const monitorStatus = stale ? 'stale' : (parsed.status || 'unknown');
    const checks = parsed.checks || {};
    const dispatch = loadChangeDeskDispatch(parsed.dispatch);
    const history = summarizeMonitorHistory(loadMonitorHistory());

    const monitor = {
        available: true,
        status: monitorStatus,
        rawStatus: parsed.status || 'unknown',
        mode: parsed.mode || 'observer',
        path: HA_MONITOR_STATE_FILE,
        generatedAt: parsed.generated_at || '',
        ageSeconds,
        stale,
        intervalSeconds,
        logLines: parsed.log_lines || null,
        currentIssues: (parsed.current_issues || []).slice(0, 8).map(normalizeMonitorIssue),
        persistentIssues: (parsed.persistent_issues || []).slice(0, 8).map(normalizeMonitorIssue),
        triage: normalizeMonitorTriage(parsed.triage || parsed.delta?.triage || {}),
        logCounts: checks.logs?.counts || {},
        states: {
            status: checks.states?.status || 'unknown',
            entityCount: checks.states?.entity_count ?? null,
            unavailableSamples: (checks.states?.unavailable_samples || []).slice(0, 6),
            unknownSamples: (checks.states?.unknown_samples || []).slice(0, 6)
        },
        mcp: {
            status: checks.mcp?.status || 'unknown',
            componentLoaded: Boolean(checks.mcp?.component_loaded)
        },
        dispatch,
        taskSlots: parsed.task_slots || {},
        mtimeMs: stat.mtimeMs
    };
    monitor.history = history;
    monitor.conditions = buildConditionLedger(monitor, history);
    return monitor;
}

function buildChangeDeskRecommendations(snapshot) {
    const recommendations = [];
    const repeatedLogs = snapshot.logs?.repeated || [];
    const hardRepeatedLogs = repeatedLogs.filter(isHardErrorIssue);
    const localizedRepeatedLogs = repeatedLogs.filter(isLowRiskLocalNoise);
    const monitorPersistent = snapshot.monitor?.persistentIssues || [];
    const monitorConfigBlockers = monitorPersistent.filter((item) => item.classification?.configBlocker);
    const monitorPriorityChecks = monitorPersistent.filter((item) => item.classification?.requiresHumanPriorityCheck);
    const monitorLocalizedNoise = monitorPersistent.filter(isLowRiskLocalNoise);

    if (snapshot.audit?.available && snapshot.audit.status === 'failed') {
        recommendations.push('Fix YAML audit issues before running a Home Assistant reload.');
    }

    if (snapshot.coreCheck?.available && snapshot.coreCheck.status === 'failed') {
        recommendations.push('Treat Home Assistant core check failures as blockers before restart.');
    }

    if (snapshot.coreCheck?.available && snapshot.coreCheck.timedOut) {
        recommendations.push('Core check is still running or timed out; rerun it in Shell mode before applying changes.');
    }

    if (snapshot.logs?.available && hardRepeatedLogs.length > 0) {
        recommendations.push('Review repeated Home Assistant log issues before reload or restart.');
    } else if (snapshot.logs?.available && localizedRepeatedLogs.length > 0) {
        recommendations.push('Repeated log issues look like localized device connectivity noise; confirm the devices are non-critical before spending config time.');
    } else if (snapshot.logs?.available && snapshot.logs.status === 'error') {
        recommendations.push('Recent Home Assistant logs include errors; inspect them before applying changes.');
    } else if (snapshot.logs?.available && snapshot.logs.status === 'warning') {
        recommendations.push('Recent Home Assistant logs include warnings worth checking.');
    }

    if (snapshot.monitor?.available && monitorConfigBlockers.length > 0) {
        recommendations.push('HA monitor sees persistent configuration or setup blockers; review them before changing Home Assistant.');
    } else if (snapshot.monitor?.available && monitorPriorityChecks.length > 0) {
        recommendations.push('HA monitor sees persistent issues on safety/security/critical-looking entities; confirm priority before treating them as benign noise.');
    } else if (snapshot.monitor?.available && monitorLocalizedNoise.length > 0 && monitorLocalizedNoise.length === monitorPersistent.length) {
        recommendations.push('HA monitor sees persistent localized connectivity noise; network or device health is more likely than broken Home Assistant config.');
    } else if (snapshot.monitor?.available && snapshot.monitor.persistentIssues?.length > 0) {
        recommendations.push('HA monitor has persistent issues; review them before changing Home Assistant.');
    } else if (snapshot.monitor?.available && snapshot.monitor.status === 'stale') {
        recommendations.push('HA monitor state is stale; check the add-on log or run `ha-monitor once`.');
    } else if (!snapshot.monitor?.available) {
        recommendations.push('HA monitor has not reported yet; wait for the first interval or run `ha-monitor once`.');
    }

    if (snapshot.monitor?.dispatch?.meaningfulDelta) {
        recommendations.push('Change Desk dispatch has a meaningful delta; use Send Report when you want model judgment.');
    } else if (snapshot.monitor?.dispatch?.available) {
        recommendations.push('Change Desk dispatch is quiet; no scheduled reasoning is warranted by the monitor packet.');
    }

    if (snapshot.live?.available) {
        recommendations.push('Live Home Assistant API is reachable for entity and service verification.');
    }

    if (snapshot.mcp?.available && snapshot.mcp.componentLoaded) {
        recommendations.push('MCP Server integration is loaded; exposed entities can be checked before assistant-facing changes.');
    }

    return recommendations;
}

async function collectChangeDeskSnapshot() {
    const startedAt = Date.now();
    const [audit, coreCheck, logs, live, mcp] = await Promise.all([
        collectChangeDeskAudit(),
        collectChangeDeskCoreCheck(),
        collectChangeDeskLogs(),
        collectChangeDeskLive(),
        collectChangeDeskMcp()
    ]);
    const monitor = collectChangeDeskMonitor();
    const snapshot = {
        success: true,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        workspace: CONFIG_ROOT,
        audit,
        coreCheck,
        logs,
        live,
        mcp,
        monitor
    };

    snapshot.recommendations = buildChangeDeskRecommendations(snapshot);
    snapshot.mallCop = buildMallCopState(loadMallCopMemory());
    return snapshot;
}

function formatCountMap(counts) {
    return Object.entries(counts || {})
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => `${key}:${value}`)
        .join(', ') || 'none';
}

function buildMallCopObservationPacket(snapshot, previousMemory = null) {
    const monitor = snapshot.monitor || {};
    const dispatch = monitor.dispatch || {};
    const gate = dispatch.reasoningGate || {};
    const history = monitor.history || {};
    const conditions = monitor.conditions || [];
    const currentDigest = buildMallCopDigest(snapshot);
    const memory = buildMallCopMemoryLines(previousMemory, currentDigest);
    const lines = [
        '# Mall Cop: To Observe and Report',
        '',
        'Purpose: make sense of changing Home Assistant log and entity states without assuming every repeated warning is a fixable config bug.',
        '',
        'Rules for this response:',
        '- Return concise advice for a human Change Desk panel.',
        '- Separate acute health from chronic conditions.',
        '- Use Mall Cop Memory to say what changed, what resolved, and what persisted with no material change since the last Mall Cop run.',
        '- Call out whether each chronic condition looks Codex-fixable, network/device-shaped, auth-shaped, config-shaped, or human-priority-only.',
        '- Treat repeated Modbus, Wi-Fi, timeout, unavailable, and socket noise as localized connectivity unless evidence says it is spreading or critical.',
        '- Do not suggest reload, restart, service calls, config edits, or shell commands as actions unless the packet shows a clear blocker.',
        '- Do not ask follow-up questions; state assumptions and what to observe next.',
        '- Do not include the "Mall Cop: To Observe and Report" title in the answer; the UI already labels the report.',
        '',
        'Requested output shape:',
        '1. Bottom line',
        '2. Acute state',
        '3. Chronic conditions',
        '4. What changed',
        '5. What Codex can and cannot fix',
        '6. Next observation',
        '',
        '## Snapshot',
        `Generated: ${snapshot.generatedAt || 'unknown'}`,
        `Workspace: ${snapshot.workspace || CONFIG_ROOT}`,
        `Monitor status: ${monitor.status || 'unavailable'}; raw=${monitor.rawStatus || 'unknown'}; stale=${Boolean(monitor.stale)}; age=${monitor.ageSeconds ?? 'unknown'}s`,
        `Current issues: ${(monitor.currentIssues || []).length}; persistent issues: ${(monitor.persistentIssues || []).length}`,
        `Log status: ${snapshot.logs?.status || 'unavailable'}; errors=${(snapshot.logs?.counts?.critical || 0) + (snapshot.logs?.counts?.error || 0)}; warnings=${snapshot.logs?.counts?.warning || 0}`,
        `State scan: ${monitor.states?.status || 'unknown'}; entity_count=${monitor.states?.entityCount ?? 'unknown'}; unavailable_samples=${(monitor.states?.unavailableSamples || []).length}; unknown_samples=${(monitor.states?.unknownSamples || []).length}`,
        `Config fingerprint changed in delta: ${dispatch.delta?.configChanged === true ? 'yes' : (dispatch.delta?.configChanged === false ? 'no' : 'unknown')}`,
        '',
        '## History Window',
        `Samples: ${history.samples || 0}; first=${history.firstSeen || 'unknown'}; last=${history.lastSeen || 'unknown'}`,
        `Status counts: ${formatCountMap(history.statusCounts)}`,
        `Posture counts: ${formatCountMap(history.postureCounts)}`,
        `Meaningful deltas: ${history.meaningfulDeltas ?? 0}; config changes: ${history.configChanges ?? 0}`,
        `Recent current issue counts: ${(history.recentCurrentIssues || []).join(', ') || 'none'} (${history.currentIssueDirection || 'unknown'})`,
        `Recent persistent issue counts: ${(history.recentPersistentIssues || []).join(', ') || 'none'} (${history.persistentIssueDirection || 'unknown'})`,
        `Recent log error direction: ${history.logErrorDirection || 'unknown'}`,
        '',
        ...memory.lines,
        '',
        '## Deterministic Triage',
        `Dominant posture: ${monitor.triage?.dominantPosture || 'unknown'}`,
        `Localized noise: ${monitor.triage?.localizedNoiseCount ?? 0}; config blockers: ${monitor.triage?.configBlockerCount ?? 0}; priority checks: ${monitor.triage?.priorityCheckCount ?? 0}`,
        ...((monitor.triage?.summaryLines || []).map((line) => `- ${line}`)),
        '',
        '## Dispatch Delta',
        `Dispatch status: ${dispatch.status || 'unavailable'}; meaningful=${Boolean(dispatch.meaningfulDelta)}`,
        `Reasoning gate: automatic_llm_calls=${gate.automaticLlmCalls ? 'enabled' : 'disabled'}; low_reasoning=${gate.lowReasoningEligible ? 'eligible' : 'deferred'}; high_reasoning_requires_user_action=${gate.highReasoningRequiresUserAction !== false}`,
        ...((dispatch.delta?.summaryLines || []).map((line) => `- ${line}`)),
        '',
        '## Chronic Condition Ledger'
    ];

    if (!conditions.length) {
        lines.push('- No chronic conditions are currently grouped by the monitor.');
    } else {
        conditions.forEach((condition, index) => {
            lines.push(
                '',
                `### Condition ${index + 1}: ${condition.label}`,
                `Category/posture/source: ${condition.category} / ${condition.posture} / ${condition.source}`,
                `Trajectory: ${condition.trajectory}; issues=${condition.issueCount}; active=${condition.activeCount}; chronic=${condition.chronicCount}; runs=${condition.totalRuns}; occurrences=${condition.totalOccurrences}`,
                `First seen: ${condition.firstSeen || 'unknown'}; last seen: ${condition.lastSeen || 'unknown'}`,
                `Impact: ${condition.impact || 'unknown'}`,
                `Codex actionability: ${condition.codexActionability || 'unknown'}`,
                `System-wide risk: ${condition.systemWideRisk || 'unknown'}; config_blocker=${condition.configBlocker}; human_priority_check=${condition.requiresHumanPriorityCheck}`
            );
            for (const sample of condition.samples || []) {
                lines.push(`- ${sample.runsSeen} runs/${sample.occurrences} occurrences/${sample.active ? 'active' : 'quiet'}: ${sample.sample}`);
            }
        });
    }

    lines.push(
        '',
        '## Recommendations Already Computed',
        ...((snapshot.recommendations || []).map((item) => `- ${item}`)),
        '',
        'Now produce the requested Mall Cop summary. Keep it under 500 words.'
    );

    return redactSensitiveText(lines.join('\n'));
}

function runCodexMallCopObservation(prompt) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        let tempDir = '';
        let child;
        const unsafeTestMode = process.env.NODE_ENV === 'test'
            && process.env.IMAGE_SERVICE_TEST_MODE === 'true';
        try {
            if (unsafeTestMode) {
                tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-desk-mall-cop-'));
            } else {
                refreshMallCopJailRuntimeFiles(JAIL_ROOT);
                tempDir = fs.mkdtempSync(path.join(JAIL_ROOT, 'work', 'run-'));
            }
        } catch (err) {
            resolve({
                success: false,
                exitCode: null,
                timedOut: false,
                durationMs: Date.now() - startedAt,
                summary: '',
                output: '',
                error: redactSensitiveText(err.message)
            });
            return;
        }
        const outputFile = path.join(tempDir, 'summary.md');
        const sourceCodexHome = process.env.CODEX_HOME || '/data/.codex';

        try {
            if (unsafeTestMode) {
                const directArgs = buildMallCopCodexArgs(tempDir, outputFile);
                const testCodexPath = process.env.IMAGE_SERVICE_TEST_CODEX_PATH;
                if (!testCodexPath || !path.isAbsolute(testCodexPath)) {
                    throw new Error('IMAGE_SERVICE_TEST_CODEX_PATH must be absolute in Mall Cop test mode');
                }
                child = spawn(testCodexPath, directArgs, {
                    cwd: tempDir,
                    env: buildMallCopCodexEnvironment(
                        process.env,
                        tempDir,
                        tempDir,
                        sourceCodexHome
                    ),
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } else {
                const sandboxWorkDir = `${SANDBOX_WORK_ROOT}/${path.basename(tempDir)}`;
                prepareMallCopSandbox(tempDir, sourceCodexHome, JAIL_UID, JAIL_GID);
                const sandboxOutputFile = `${sandboxWorkDir}/summary.md`;
                const codexArgs = buildMallCopCodexArgs(sandboxWorkDir, sandboxOutputFile);
                child = spawn(
                    '/opt/scripts/codex-terminal-mall-cop-jail.py',
                    buildMallCopJailLauncherArgs(JAIL_ROOT, sandboxWorkDir, codexArgs),
                    {
                    cwd: tempDir,
                    env: buildMallCopCodexEnvironment(
                        process.env,
                        `${sandboxWorkDir}/home`,
                        `${sandboxWorkDir}/tmp`,
                        `${sandboxWorkDir}/codex-home`
                    ),
                    stdio: ['pipe', 'pipe', 'pipe']
                    }
                );
            }
        } catch (err) {
            fs.rm(tempDir, { recursive: true, force: true }, () => {});
            resolve({
                success: false,
                exitCode: null,
                timedOut: false,
                durationMs: Date.now() - startedAt,
                summary: '',
                output: '',
                error: redactSensitiveText(err.message)
            });
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timeoutTriggered = false;
        let forceKillTimer = null;
        const cleanupTempDir = () => {
            fs.rm(tempDir, { recursive: true, force: true }, () => {});
        };
        const settleFailure = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
            }
            child?.kill('SIGTERM');
            cleanupTempDir();
            resolve({
                success: false,
                exitCode: null,
                timedOut: false,
                durationMs: Date.now() - startedAt,
                summary: '',
                output: '',
                error: redactSensitiveText(err.message)
            });
        };
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            timeoutTriggered = true;
            child.kill('SIGTERM');
            forceKillTimer = setTimeout(() => {
                if (!settled) {
                    child.kill('SIGKILL');
                }
            }, 3000);
        }, CHANGE_DESK_MALL_COP_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > CHANGE_DESK_MALL_COP_MAX_CHARS * 2) {
                stdout = stdout.slice(-CHANGE_DESK_MALL_COP_MAX_CHARS);
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > CHANGE_DESK_MALL_COP_MAX_CHARS * 2) {
                stderr = stderr.slice(-CHANGE_DESK_MALL_COP_MAX_CHARS);
            }
        });
        child.on('error', settleFailure);
        child.on('close', (code, signal) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
            }
            let summary = '';
            try {
                summary = fs.readFileSync(outputFile, 'utf8');
            } catch {
                summary = stdout;
            }
            const output = truncateChangeDeskText(stdout, CHANGE_DESK_MALL_COP_MAX_CHARS);
            const error = truncateChangeDeskText(stderr, CHANGE_DESK_MALL_COP_MAX_CHARS);
            const text = truncateChangeDeskText(summary || stdout, CHANGE_DESK_MALL_COP_MAX_CHARS);
            resolve({
                success: code === 0 && Boolean(text.text.trim()),
                exitCode: Number.isInteger(code) ? code : null,
                signal: signal || '',
                timedOut: timeoutTriggered || signal === 'SIGTERM' || signal === 'SIGKILL',
                durationMs: Date.now() - startedAt,
                summary: text.text.trim(),
                output: output.text,
                error: error.text,
                truncated: text.truncated || output.truncated || error.truncated
            });
            cleanupTempDir();
        });
        endChildStdin(child.stdin, protectMallCopPrompt(prompt), settleFailure);
    });
}

async function runMallCopForSnapshot(snapshot, trigger = 'manual') {
    if (mallCopRunInFlight) {
        return mallCopRunInFlight;
    }

    mallCopRunInFlight = (async () => {
        const previousMemory = loadMallCopMemory();
        const packet = buildMallCopObservationPacket(snapshot, previousMemory);
        const report = writeChangeDeskReport(packet);
        const observation = await runCodexMallCopObservation(packet);

        if (!observation.success) {
            const failedMemory = buildFailedMallCopAttempt(
                previousMemory,
                observation,
                report,
                trigger
            );
            saveMallCopMemory(failedMemory);
            return {
                success: false,
                report,
                observation,
                memory: failedMemory
            };
        }

        const memory = buildMallCopMemoryRecord(snapshot, observation, report, previousMemory, trigger);
        saveMallCopMemory(memory);
        return {
            success: true,
            report,
            observation: memory.observation,
            memory
        };
    })();

    try {
        return await mallCopRunInFlight;
    } finally {
        mallCopRunInFlight = null;
    }
}

function runTerminalControl(action, callback) {
    if (!SUPPORTED_TERMINAL_CONTROL_ACTIONS.has(action)) {
        callback(new Error('Unsupported terminal control action'));
        return;
    }

    const target = activeTmuxTarget();

    if (LIVE_CONTROL_KEYS.has(action)) {
        cancelCopyModeIfNeeded((modeErr) => {
            if (modeErr) {
                callback(modeErr);
                return;
            }

            runTmux(['send-keys', '-t', target, LIVE_CONTROL_KEYS.get(action)], callback);
        }, target);
        return;
    }

    getPaneInMode((modeErr, inMode) => {
        if (modeErr) {
            callback(modeErr);
            return;
        }

        if (action === 'scroll-up') {
            const args = inMode
                ? ['send-keys', '-t', target, '-X', 'page-up']
                : ['copy-mode', '-u', '-t', target];
            runTmux(args, callback);
            return;
        }

        if (!inMode) {
            callback(null);
            return;
        }

        const copyModeCommand = action === 'scroll-down' ? 'page-down' : 'cancel';
        runTmux(['send-keys', '-t', target, '-X', copyModeCommand], callback);
    }, target);
}

// Home Assistant ingress can serve this page from a URL ending in a double
// slash. Browsers then request paths like //terminal/, which Express does not
// match against /terminal. Normalize duplicate leading slashes before routing.
app.use((req, res, next) => {
    if (req.url.startsWith('//')) {
        req.url = req.url.replace(/^\/+/, '/');
    }
    next();
});

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Keep the opaque Home Assistant ingress path out of every Referer while
    // retaining the scheme/host proof used by same-origin request checks.
    res.setHeader('Referrer-Policy', 'strict-origin');
    next();
});

app.use((req, res, next) => {
    const healthCheck = req.path === '/health';
    // The bundled codex-shell-dispatch helper talks to this one endpoint over
    // container loopback. All browser-facing routes remain ingress-only.
    const internalShellDispatch = req.path === '/terminal-shell-command';
    if (isAllowedRequestSource(req, requestSecurityPolicy, {
        allowLoopback: healthCheck || internalShellDispatch
    })) {
        next();
        return;
    }

    console.warn(`Rejected non-ingress request from ${requestRemoteAddress(req) || 'unknown source'} to ${req.path}`);
    res.status(403).json({ success: false, error: 'This service is available only through Home Assistant ingress' });
});

function requireSameOriginBrowserRequest(req, res, next) {
    if (!isSameOriginBrowserRequest(req)) {
        res.status(403).json({ success: false, error: 'A same-origin browser request is required' });
        return;
    }
    next();
}

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o755 });
    console.log(`Created upload directory: ${UPLOAD_DIR}`);
}

function listManagedUploads() {
    try {
        return fs.readdirSync(UPLOAD_DIR)
            .filter((filename) => filename.startsWith('pasted-'))
            .map((filename) => {
                const filePath = path.join(UPLOAD_DIR, filename);
                const stat = fs.statSync(filePath);
                return {
                    filename,
                    path: filePath,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    isFile: stat.isFile()
                };
            })
            .filter((entry) => entry.isFile);
    } catch (err) {
        console.error('Unable to list uploaded images:', err.message);
        return [];
    }
}

function removeUpload(entry) {
    try {
        fs.unlinkSync(entry.path);
        console.log(`Removed old uploaded image: ${entry.path}`);
        return entry.size;
    } catch (err) {
        console.error(`Unable to remove uploaded image ${entry.path}:`, err.message);
        return 0;
    }
}

function cleanupUploads(protectedFilename = '') {
    let files = listManagedUploads();
    let removed = 0;
    let removedBytes = 0;

    if (IMAGE_RETENTION_DAYS > 0) {
        const cutoff = Date.now() - (IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        for (const entry of files) {
            if (entry.filename !== protectedFilename && entry.mtimeMs < cutoff) {
                removedBytes += removeUpload(entry);
                removed += 1;
            }
        }
        files = listManagedUploads();
    }

    if (IMAGE_RETENTION_MAX_BYTES > 0) {
        let totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
        const oldestFirst = files
            .filter((entry) => entry.filename !== protectedFilename)
            .sort((a, b) => a.mtimeMs - b.mtimeMs);

        for (const entry of oldestFirst) {
            if (totalBytes <= IMAGE_RETENTION_MAX_BYTES) {
                break;
            }
            const bytes = removeUpload(entry);
            totalBytes -= bytes;
            removedBytes += bytes;
            removed += 1;
        }
    }

    if (removed > 0) {
        console.log(`Upload retention cleanup removed ${removed} file(s), ${(removedBytes / 1024).toFixed(2)} KB`);
    }
}

cleanupUploads();

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const nonce = crypto.randomBytes(12).toString('hex');
        const originalExt = path.extname(file.originalname || '').toLowerCase();
        const ext = ALLOWED_IMAGE_EXTENSIONS.has(originalExt)
            ? originalExt
            : extensionForMime(file.mimetype);
        const filename = `pasted-${timestamp}-${nonce}${ext}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: UPLOAD_MAX_BYTES,
        files: 1,
        fields: 4,
        parts: 5,
        fieldNameSize: 64,
        fieldSize: 1024
    },
    fileFilter: (req, file, cb) => {
        if (isAllowedImage(file)) {
            cb(null, true);
        } else {
            const error = new Error('Only supported image files are allowed');
            error.code = 'UNSUPPORTED_IMAGE_TYPE';
            cb(error);
        }
    }
});

// API routes MUST come before static files middleware
// Otherwise static middleware will intercept API requests
app.use(express.json({ limit: '512kb' }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uploadDir: UPLOAD_DIR, workspace: CONFIG_ROOT });
});

// Provide ttyd port to frontend
app.get('/config', (req, res) => {
    res.json({
        ttydPort: TTYD_PORT,
        uploadDir: UPLOAD_DIR,
        workspace: CONFIG_ROOT,
        terminalMode: activeTerminalMode
    });
});

app.get('/change-desk/summary', async (req, res) => {
    if (!isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin Change Desk access is not allowed' });
    }

    try {
        const snapshot = await collectChangeDeskSnapshot();
        res.json(snapshot);
    } catch (err) {
        console.error('Change Desk snapshot failed:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to collect Change Desk snapshot'
        });
    }
});

app.post('/change-desk/report', (req, res) => {
    if (!isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin Change Desk report access is not allowed' });
    }

    const report = typeof req.body?.report === 'string' ? req.body.report : '';

    if (!report.trim()) {
        return res.status(400).json({ success: false, error: 'No Change Desk report provided' });
    }

    try {
        const written = writeChangeDeskReport(report);
        res.json({ success: true, ...written });
    } catch (err) {
        console.error('Failed to stage Change Desk report:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to stage Change Desk report'
        });
    }
});

app.post('/change-desk/mall-cop', async (req, res) => {
    if (!isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin Mall Cop access is not allowed' });
    }

    try {
        const automatic = req.body?.mode === 'auto';
        const force = req.body?.force === true || !automatic;
        const snapshot = await collectChangeDeskSnapshot();
        const currentMemory = loadMallCopMemory();

        if (!force && !isMallCopAutoDue(currentMemory)) {
            snapshot.mallCop = buildMallCopState(currentMemory);
            return res.json({
                success: true,
                skipped: true,
                reason: 'Mall Cop memory is still fresh',
                generatedAt: new Date().toISOString(),
                observation: mallCopObservationForClient(currentMemory),
                memory: snapshot.mallCop,
                snapshot
            });
        }

        const result = await runMallCopForSnapshot(snapshot, automatic ? 'auto' : 'manual');

        if (!result.success) {
            return res.status(result.observation.timedOut ? 504 : 502).json({
                success: false,
                error: result.observation.timedOut ? 'Mall Cop summary timed out' : 'Codex did not return a Mall Cop summary',
                observation: result.observation,
                packetPath: result.report.path,
                snapshot
            });
        }

        snapshot.mallCop = buildMallCopState(result.memory);

        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            packetPath: result.report.path,
            packetTruncated: result.report.truncated,
            observation: mallCopObservationForClient(result.memory),
            memory: snapshot.mallCop,
            snapshot
        });
    } catch (err) {
        console.error('Mall Cop observation failed:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to run Mall Cop observation'
        });
    }
});

app.get('/terminal-mode', (req, res) => {
    res.json({ success: true, mode: activeTerminalMode });
});

// How many browsers are currently attached. The page uses this to decide
// whether a backgrounded tab should release its terminal client: a lone client
// stays attached (so a single device never reloads on return), while additional
// clients release so the visible device is not sized down to fit a screen
// nobody is looking at.
app.get('/terminal-clients', (req, res) => {
    readAttachedClientCount((err, count) => {
        if (err) {
            console.error('Failed to count terminal clients:', err.message);
            return res.status(502).json({ success: false, error: 'Failed to count terminal clients' });
        }

        res.json({ success: true, count });
    });
});

app.post('/terminal-mode', (req, res) => {
    const mode = typeof req.body?.mode === 'string' ? req.body.mode : '';

    if (!isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin terminal mode changes are not allowed' });
    }

    if (!TERMINAL_MODES.has(mode)) {
        return res.status(400).json({ success: false, error: 'Unsupported terminal mode' });
    }

    selectTerminalMode(mode, (err) => {
        if (err) {
            console.error(`Terminal mode ${mode} failed:`, err.message);
            return res.status(502).json({ success: false, error: 'Failed to switch terminal mode' });
        }

        res.json({ success: true, mode: activeTerminalMode });
    });
});

// Image upload endpoint
app.post('/upload', requireSameOriginBrowserRequest, upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
    }

    const filePath = path.join(UPLOAD_DIR, req.file.filename);
    if (!isValidImageContent(filePath, req.file.mimetype || '', req.file.filename)) {
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            console.error(`Unable to remove rejected upload ${filePath}:`, err.message);
        }
        return res.status(400).json({ success: false, error: 'Uploaded file is not a valid supported image' });
    }

    console.log(`Image uploaded: ${filePath} (${(req.file.size / 1024).toFixed(2)} KB)`);
    cleanupUploads(req.file.filename);

    res.json({
        success: true,
        path: filePath,
        filename: req.file.filename,
        size: req.file.size
    });
});

// Insert text into the persistent terminal session. This is used after image
// upload so the image path lands in the Codex prompt even when browser paste
// into the ttyd iframe is blocked.
app.post('/terminal-input', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';

    if (!isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin terminal input is not allowed' });
    }

    if (!text.trim()) {
        return res.status(400).json({ success: false, error: 'No terminal input provided' });
    }

    if (text.length > 4096) {
        return res.status(400).json({ success: false, error: 'Terminal input is too long' });
    }

    if (hasControlCharacters(text)) {
        return res.status(400).json({ success: false, error: 'Terminal input contains unsupported control characters' });
    }

    const target = activeTmuxTarget();

    cancelCopyModeIfNeeded((modeErr) => {
        if (modeErr) {
            console.error(`Failed to return ${target} to live prompt:`, modeErr.message);
            return res.status(502).json({
                success: false,
                error: 'Failed to insert text into terminal session'
            });
        }

        runTmux(['send-keys', '-t', target, '-l', '--', text], (err) => {
            if (err) {
                console.error(`Failed to insert terminal input into ${target}:`, err.message);
                return res.status(502).json({
                    success: false,
                    error: 'Failed to insert text into terminal session'
                });
            }

            res.json({ success: true });
        });
    }, target);
});

// Paste user-supplied clipboard text into the terminal. Unlike /terminal-input,
// this endpoint accepts tabs/newlines because it is bound to an explicit Paste
// button gesture in the browser UI.
app.post('/terminal-paste', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';

    if (!isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin terminal paste is not allowed' });
    }

    if (!text.trim()) {
        return res.status(400).json({ success: false, error: 'No terminal paste text provided' });
    }

    if (text.length > 16384) {
        return res.status(400).json({ success: false, error: 'Terminal paste is too long' });
    }

    if (hasUnsupportedPasteCharacters(text)) {
        return res.status(400).json({ success: false, error: 'Terminal paste contains unsupported control characters' });
    }

    const target = activeTmuxTarget();

    cancelCopyModeIfNeeded((modeErr) => {
        if (modeErr) {
            console.error(`Failed to return ${target} to live prompt before paste:`, modeErr.message);
            return res.status(502).json({ success: false, error: 'Failed to prepare terminal paste' });
        }

        loadTmuxPasteBuffer(text, {}, (loadErr, bufferName) => {
            if (loadErr) {
                console.error(`Failed to load tmux paste buffer for ${target}:`, loadErr.message);
                res.status(502).json({ success: false, error: 'Failed to prepare terminal paste' });
                return;
            }

            runTmux(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', target], (err) => {
                if (err) {
                    console.error(`Failed to paste into ${target}:`, err.message);
                    return res.status(502).json({ success: false, error: 'Failed to paste into terminal session' });
                }

                res.json({ success: true });
            });
        });
    }, target);
});

// Dispatch a human-prefixed command to the raw shell pane. The frontend only
// calls this after the user types ",," at the Codex prompt or mobile command
// bar; it is not used by Codex's own command execution path.
app.post('/terminal-shell-command', (req, res) => {
    const requestedCommand = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    const command = normalizeShellCommandForDispatch(requestedCommand);

    const internalLoopbackRequest = isLoopbackAddress(requestRemoteAddress(req));
    if (!internalLoopbackRequest && !isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin shell command dispatch is not allowed' });
    }

    if (!command) {
        return res.status(400).json({ success: false, error: 'No shell command provided' });
    }

    if (command.length > RAW_SHELL_COMMAND_MAX_LENGTH) {
        return res.status(400).json({ success: false, error: 'Shell command is too long' });
    }

    if (hasControlCharacters(command)) {
        return res.status(400).json({ success: false, error: 'Shell command contains unsupported control characters' });
    }

    const queuedRequest = new AbortController();
    const cancelIfDisconnected = () => {
        if (!res.writableEnded) {
            queuedRequest.abort();
        }
    };
    req.once('aborted', cancelIfDisconnected);
    res.once('close', cancelIfDisconnected);

    enqueueRawShellCommand(command, (err, result = {}) => {
        req.off('aborted', cancelIfDisconnected);
        res.off('close', cancelIfDisconnected);
        if (res.writableEnded || res.destroyed) {
            return;
        }
        if (err) {
            console.error(`Failed to dispatch raw shell command to ${RAW_TMUX_TARGET}:`, err.message);
            if (err.code === 'QUEUE_FULL' || err.code === 'QUEUE_WAIT_TIMEOUT') {
                return res.status(429).json({ success: false, error: 'Too many shell commands are already queued' });
            }
            return res.status(502).json({ success: false, error: 'Failed to dispatch shell command' });
        }

        res.json({
            success: true,
            command,
            mode: result.mode || activeTerminalMode,
            output: result.output || '',
            exitCode: result.exitCode,
            timedOut: Boolean(result.timedOut),
            terminated: Boolean(result.terminated),
            truncated: Boolean(result.truncated)
        });
    }, { signal: queuedRequest.signal });
});

app.post('/terminal-control', (req, res) => {
    const action = typeof req.body?.action === 'string' ? req.body.action : '';

    if (!isSameOriginBrowserRequest(req)) {
        return res.status(403).json({ success: false, error: 'Cross-origin terminal control is not allowed' });
    }

    if (!SUPPORTED_TERMINAL_CONTROL_ACTIONS.has(action)) {
        return res.status(400).json({ success: false, error: 'Unsupported terminal control action' });
    }

    runTerminalControl(action, (err) => {
        if (err) {
            console.error(`Terminal control ${action} failed for ${activeTmuxTarget()}:`, err.message);
            return res.status(502).json({ success: false, error: 'Failed to control terminal session' });
        }

        res.json({ success: true });
    });
});

// Proxy endpoint for ttyd terminal.
// This allows ttyd to work through Home Assistant ingress without publishing
// the ttyd port on the host. Keep a reference so websocket upgrades are routed
// explicitly by the HTTP server below.
function shouldRedirectTerminalDocumentRequest(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return false;
    }

    const terminalPath = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '') || '/';
    if (terminalPath !== '/terminal') {
        return false;
    }

    const acceptsHtml = String(req.get('accept') || '').includes('text/html');
    if (!acceptsHtml) {
        return false;
    }

    const fetchDest = String(req.get('sec-fetch-dest') || '').toLowerCase();
    if (req.query?.embedded === '1' || fetchDest === 'iframe') {
        return false;
    }

    return true;
}

app.use('/terminal', (req, res, next) => {
    if (!shouldRedirectTerminalDocumentRequest(req)) {
        next();
        return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, req.originalUrl.endsWith('/') ? '../' : './');
});

const terminalProxy = createProxyMiddleware({
    target: `http://localhost:${TTYD_PORT}`,
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
    pathRewrite: {
        '^/terminal': '' // Remove /terminal prefix when forwarding
    },
    onError: (err, req, res) => {
        console.error('Proxy error:', err.message);
        // res may be a raw socket (WebSocket) instead of an Express response
        if (typeof res.status === 'function') {
            res.status(502).send('Failed to connect to terminal');
        } else if (typeof res.end === 'function') {
            res.end();
        }
    },
    logLevel: 'warn'
});

app.use('/terminal', terminalProxy);

// Serve static files (HTML interface) - MUST be after API routes.
// Do not expose /data/images through express.static; uploaded files are paths
// for Codex to read, not browser-served content.
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store');
    }
}));

// Multer error handling middleware
app.use((err, req, res, next) => {
    if (req.file?.path) {
        try {
            fs.unlinkSync(req.file.path);
        } catch (cleanupErr) {
            if (cleanupErr.code !== 'ENOENT') {
                console.error('Unable to clean up failed upload:', cleanupErr.message);
            }
        }
    }

    if (err instanceof multer.MulterError) {
        console.error('Multer error:', err.message);
        return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
            success: false,
            error: `Upload error: ${err.message}`
        });
    }

    if (err?.code === 'UNSUPPORTED_IMAGE_TYPE') {
        return res.status(400).json({ success: false, error: err.message });
    }

    if (err?.type === 'entity.too.large' || err?.status === 413) {
        return res.status(413).json({ success: false, error: 'Request body is too large' });
    }

    if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
        return res.status(400).json({ success: false, error: 'Request body is not valid JSON' });
    }

    if (err) {
        console.error('Error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Request failed'
        });
    }

    next();
});

// Create HTTP server and start listening
const server = http.createServer({ maxHeaderSize: 16 * 1024 }, app);

server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('//')) {
        req.url = req.url.replace(/^\/+/, '/');
    }

    const upgradePath = String(req.url || '').split('?', 1)[0];
    const terminalUpgrade = upgradePath === '/terminal' || upgradePath.startsWith('/terminal/');
    if (terminalUpgrade && isAuthorizedWebSocketRequest(req, requestSecurityPolicy)) {
        terminalProxy.upgrade(req, socket, head);
        return;
    }

    console.warn(`Rejected WebSocket upgrade from ${requestRemoteAddress(req) || 'unknown source'}`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Codex Terminal Image Service running on port ${PORT}`);
    console.log(`Upload directory: ${UPLOAD_DIR}`);
    console.log(`Upload retention: ${IMAGE_RETENTION_DAYS} day(s), ${IMAGE_RETENTION_MAX_BYTES} bytes`);
    console.log(`ttyd terminal on port: ${TTYD_PORT}`);
    console.log(`tmux Codex target: ${CODEX_TMUX_TARGET}`);
    console.log(`tmux raw shell target: ${RAW_TMUX_TARGET}`);
    console.log(`Terminal proxy available at /terminal/`);
    console.log(`Trusted Home Assistant ingress proxy address(es): ${[...requestSecurityPolicy.trustedIngressAddresses].join(', ')}`);
    if (requestSecurityPolicy.allowLoopbackDevelopment) {
        console.warn('Loopback-only development access is enabled by IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT=true');
    }
});
