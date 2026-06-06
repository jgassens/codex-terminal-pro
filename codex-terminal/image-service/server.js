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
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { normalizeShellCommandForDispatch } = require('./shell-command-normalizer');

const app = express();
const PORT = process.env.IMAGE_SERVICE_PORT || 7680;
const TTYD_PORT = process.env.TTYD_PORT || 7681;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/images';
const CONFIG_ROOT = process.env.HA_CONFIG_DIR || '/config';
const HA_MONITOR_STATE_FILE = process.env.HA_MONITOR_STATE_FILE || '/data/monitor/ha-monitor.json';
const CHANGE_DESK_DISPATCH_FILE = process.env.CHANGE_DESK_DISPATCH_FILE || '/data/monitor/change-desk-dispatch.json';
const CHANGE_DESK_REPORT_DIR = process.env.CHANGE_DESK_REPORT_DIR || '/data/monitor/reports';
const CODEX_TMUX_TARGET = process.env.CODEX_TMUX_TARGET || process.env.TMUX_TARGET || 'codex-terminal:0.0';
const TMUX_SESSION = process.env.TMUX_SESSION || CODEX_TMUX_TARGET.split(':')[0] || 'codex-terminal';
const RAW_TERMINAL_WINDOW = process.env.RAW_TERMINAL_WINDOW || 'raw-shell';
const RAW_TMUX_TARGET = `${TMUX_SESSION}:${RAW_TERMINAL_WINDOW}.0`;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const RAW_SHELL_COMMAND_MAX_LENGTH = 4096;
const RAW_SHELL_COMMAND_TIMEOUT_MS = parseNonNegativeInt(process.env.RAW_SHELL_COMMAND_TIMEOUT_MS, 45000);
const RAW_SHELL_CAPTURE_LINES = parseNonNegativeInt(process.env.RAW_SHELL_CAPTURE_LINES, 4000);
const RAW_SHELL_OUTPUT_MAX_CHARS = parseNonNegativeInt(process.env.RAW_SHELL_OUTPUT_MAX_CHARS, 20000);
const CHANGE_DESK_COMMAND_TIMEOUT_MS = parseNonNegativeInt(process.env.CHANGE_DESK_COMMAND_TIMEOUT_MS, 45000);
const CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS = parseNonNegativeInt(process.env.CHANGE_DESK_FAST_COMMAND_TIMEOUT_MS, 12000);
const CHANGE_DESK_OUTPUT_MAX_CHARS = parseNonNegativeInt(process.env.CHANGE_DESK_OUTPUT_MAX_CHARS, 12000);
const CHANGE_DESK_LOG_OUTPUT_MAX_CHARS = parseNonNegativeInt(process.env.CHANGE_DESK_LOG_OUTPUT_MAX_CHARS, 60000);
const CHANGE_DESK_LOG_LINE_LIMIT = parseNonNegativeInt(process.env.CHANGE_DESK_LOG_LINE_LIMIT, 500);
const CHANGE_DESK_REPORT_MAX_CHARS = parseNonNegativeInt(process.env.CHANGE_DESK_REPORT_MAX_CHARS, 200000);
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

function requestHeaderMatchesHost(req, headerName) {
    const value = req.get(headerName);
    const host = req.get('host');

    if (!value || !host) {
        return true;
    }

    try {
        const parsed = new URL(value);
        return parsed.host === host;
    } catch {
        return false;
    }
}

function isSameOriginBrowserRequest(req) {
    return requestHeaderMatchesHost(req, 'origin') && requestHeaderMatchesHost(req, 'referer');
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

        const bufferName = `codex-terminal-paste-${Date.now()}`;
        const loader = spawn('tmux', ['load-buffer', '-b', bufferName, '-'], {
            stdio: ['pipe', 'ignore', 'pipe']
        });
        let stderr = '';
        let responded = false;

        loader.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        loader.on('error', (err) => {
            console.error(`Failed to load tmux paste buffer for ${logContext}:`, err.message);
            responded = true;
            callback(err);
        });

        loader.on('close', (code) => {
            if (responded) {
                return;
            }

            if (code !== 0) {
                const err = new Error(stderr.trim() || 'tmux load-buffer failed');
                callback(err);
                return;
            }

            runTmux(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', target], callback);
        });

        loader.stdin.end(text);
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

function parseMarkedShellOutput(captured, startMarker, endMarker) {
    const lines = String(captured || '').replace(/\r/g, '').split('\n');
    const endPrefix = `${endMarker}:`;
    let startIndex = -1;
    let endIndex = -1;
    let exitCode = null;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (startIndex === -1) {
            if (line === startMarker) {
                startIndex = i;
            }
            continue;
        }

        if (line.startsWith(endPrefix)) {
            endIndex = i;
            const parsed = Number.parseInt(line.slice(endPrefix.length), 10);
            exitCode = Number.isFinite(parsed) ? parsed : null;
            break;
        }
    }

    if (startIndex === -1) {
        return { started: false, complete: false, output: '', exitCode: null, truncated: false };
    }

    if (endIndex === -1) {
        return { started: true, complete: false, output: '', exitCode: null, truncated: false };
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

function waitForMarkedShellOutput(startMarker, endMarker, callback) {
    const deadline = Date.now() + RAW_SHELL_COMMAND_TIMEOUT_MS;

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
    ensureRawTerminal((ensureErr) => {
        if (ensureErr) {
            callback(ensureErr);
            return;
        }

        const markerSuffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const startMarker = `__CTP_SHELL_START_${markerSuffix}__`;
        const endMarker = `__CTP_SHELL_END_${markerSuffix}__`;
        const wrappedCommand = `printf '\\n${startMarker}\\n'; ${command}; __ctp_status=$?; printf '\\n${endMarker}:%s\\n' "$__ctp_status"`;

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
                        callback(pasteErr);
                        return;
                    }

                    runTmux(['send-keys', '-t', RAW_TMUX_TARGET, 'Enter'], (enterErr) => {
                        if (enterErr) {
                            callback(enterErr);
                            return;
                        }

                        waitForMarkedShellOutput(startMarker, endMarker, (waitErr, result) => {
                            if (waitErr) {
                                callback(waitErr);
                                return;
                            }

                            if (result.timedOut) {
                                selectTerminalMode('raw', (selectErr) => {
                                    if (selectErr) {
                                        callback(selectErr);
                                        return;
                                    }

                                    callback(null, {
                                        ...result,
                                        mode: activeTerminalMode
                                    });
                                });
                                return;
                            }

                            callback(null, {
                                ...result,
                                mode: activeTerminalMode
                            });
                        });
                    });
                });
            });
        }, RAW_TMUX_TARGET);
    });
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
        .replace(/((?:TOKEN|SECRET|PASSWORD|PASS|KEY)[A-Z0-9_]*=)[^\s"']+/gi, '$1[redacted]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
        .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted-openai-key]')
        .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]');
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

function runChangeDeskCommand(command, args, options = {}) {
    const timeout = options.timeout || CHANGE_DESK_COMMAND_TIMEOUT_MS;
    const maxChars = options.maxChars || CHANGE_DESK_OUTPUT_MAX_CHARS;

    return new Promise((resolve) => {
        execFile(command, args, {
            cwd: CONFIG_ROOT,
            timeout,
            maxBuffer: 1024 * 1024
        }, (err, stdout = '', stderr = '') => {
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
                error: err ? redactSensitiveText(err.message) : ''
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
        maxChars: CHANGE_DESK_OUTPUT_MAX_CHARS
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            message: 'ha-toolbox is not available'
        };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(result.stdout || '{}');
    } catch {
        parsed = null;
    }

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
        maxChars: CHANGE_DESK_OUTPUT_MAX_CHARS
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            message: 'ha-api is not available'
        };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(result.stdout || '{}');
    } catch {
        parsed = null;
    }

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
        maxChars: CHANGE_DESK_OUTPUT_MAX_CHARS
    });

    if (result.notFound) {
        return {
            available: false,
            status: 'unavailable',
            message: 'ha-mcp-status is not available'
        };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(result.stdout || '{}');
    } catch {
        parsed = null;
    }

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

    return {
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
    return snapshot;
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
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

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
        const originalExt = path.extname(file.originalname || '').toLowerCase();
        const ext = ALLOWED_IMAGE_EXTENSIONS.has(originalExt)
            ? originalExt
            : extensionForMime(file.mimetype);
        const filename = `pasted-${timestamp}${ext}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: UPLOAD_MAX_BYTES // 10MB max file size
    },
    fileFilter: (req, file, cb) => {
        if (isAllowedImage(file)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
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

app.get('/terminal-mode', (req, res) => {
    res.json({ success: true, mode: activeTerminalMode });
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
app.post('/upload', upload.single('image'), (req, res) => {
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

        const bufferName = `codex-terminal-paste-${Date.now()}`;
        const loader = spawn('tmux', ['load-buffer', '-b', bufferName, '-'], {
            stdio: ['pipe', 'ignore', 'pipe']
        });
        let stderr = '';
        let responded = false;

        loader.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        loader.on('error', (err) => {
            console.error(`Failed to load tmux paste buffer for ${target}:`, err.message);
            responded = true;
            res.status(502).json({ success: false, error: 'Failed to prepare terminal paste' });
        });

        loader.on('close', (code) => {
            if (responded) {
                return;
            }

            if (code !== 0) {
                console.error(`tmux load-buffer failed for ${target}:`, stderr.trim());
                return res.status(502).json({ success: false, error: 'Failed to prepare terminal paste' });
            }

            runTmux(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', target], (err) => {
                if (err) {
                    console.error(`Failed to paste into ${target}:`, err.message);
                    return res.status(502).json({ success: false, error: 'Failed to paste into terminal session' });
                }

                res.json({ success: true });
            });
        });

        loader.stdin.end(text);
    }, target);
});

// Dispatch a human-prefixed command to the raw shell pane. The frontend only
// calls this after the user types ",," at the Codex prompt or mobile command
// bar; it is not used by Codex's own command execution path.
app.post('/terminal-shell-command', (req, res) => {
    const requestedCommand = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    const command = normalizeShellCommandForDispatch(requestedCommand);

    if (!isSameOriginBrowserRequest(req)) {
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

    dispatchRawShellCommand(command, (err, result = {}) => {
        if (err) {
            console.error(`Failed to dispatch raw shell command to ${RAW_TMUX_TARGET}:`, err.message);
            return res.status(502).json({ success: false, error: 'Failed to dispatch shell command' });
        }

        res.json({
            success: true,
            command,
            mode: result.mode || activeTerminalMode,
            output: result.output || '',
            exitCode: result.exitCode,
            timedOut: Boolean(result.timedOut),
            truncated: Boolean(result.truncated)
        });
    });
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
    if (err instanceof multer.MulterError) {
        console.error('Multer error:', err.message);
        return res.status(400).json({
            success: false,
            error: `Upload error: ${err.message}`
        });
    }

    if (err) {
        console.error('Error:', err.message);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }

    next();
});

// Create HTTP server and start listening
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('//')) {
        req.url = req.url.replace(/^\/+/, '/');
    }

    if (req.url && req.url.startsWith('/terminal')) {
        terminalProxy.upgrade(req, socket, head);
        return;
    }

    socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Codex Terminal Image Service running on port ${PORT}`);
    console.log(`Upload directory: ${UPLOAD_DIR}`);
    console.log(`Upload retention: ${IMAGE_RETENTION_DAYS} day(s), ${IMAGE_RETENTION_MAX_BYTES} bytes`);
    console.log(`ttyd terminal on port: ${TTYD_PORT}`);
    console.log(`tmux Codex target: ${CODEX_TMUX_TARGET}`);
    console.log(`tmux raw shell target: ${RAW_TMUX_TARGET}`);
    console.log(`Terminal proxy available at /terminal/`);
});
