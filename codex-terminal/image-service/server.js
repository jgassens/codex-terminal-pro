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

const app = express();
const PORT = process.env.IMAGE_SERVICE_PORT || 7680;
const TTYD_PORT = process.env.TTYD_PORT || 7681;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/images';
const CODEX_TMUX_TARGET = process.env.CODEX_TMUX_TARGET || process.env.TMUX_TARGET || 'codex-terminal:0.0';
const TMUX_SESSION = process.env.TMUX_SESSION || CODEX_TMUX_TARGET.split(':')[0] || 'codex-terminal';
const RAW_TERMINAL_WINDOW = process.env.RAW_TERMINAL_WINDOW || 'raw-shell';
const RAW_TMUX_TARGET = `${TMUX_SESSION}:${RAW_TERMINAL_WINDOW}.0`;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
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
            '/bin/bash -l'
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
app.use(express.json({ limit: '64kb' }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uploadDir: UPLOAD_DIR });
});

// Provide ttyd port to frontend
app.get('/config', (req, res) => {
    res.json({
        ttydPort: TTYD_PORT,
        uploadDir: UPLOAD_DIR,
        terminalMode: activeTerminalMode
    });
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
app.use(express.static(path.join(__dirname, 'public')));

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
