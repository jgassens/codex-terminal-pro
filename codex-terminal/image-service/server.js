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
const { execFile } = require('child_process');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.IMAGE_SERVICE_PORT || 7680;
const TTYD_PORT = process.env.TTYD_PORT || 7681;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/images';
const TMUX_TARGET = process.env.TMUX_TARGET || 'codex-terminal:0.0';
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_RETENTION_DAYS = parseNonNegativeInt(process.env.IMAGE_RETENTION_DAYS, 30);
const IMAGE_RETENTION_MAX_BYTES = parseNonNegativeInt(process.env.IMAGE_RETENTION_MAX_BYTES, 256 * 1024 * 1024);
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

// Home Assistant ingress can serve this page from a URL ending in a double
// slash. Browsers then request paths like //terminal/, which Express does not
// match against /terminal. Normalize duplicate leading slashes before routing.
app.use((req, res, next) => {
    if (req.url.startsWith('//')) {
        req.url = req.url.replace(/^\/+/, '/');
    }
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
        uploadDir: UPLOAD_DIR
    });
});

// Image upload endpoint
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
    }

    const filePath = path.join(UPLOAD_DIR, req.file.filename);
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

    if (!text.trim()) {
        return res.status(400).json({ success: false, error: 'No terminal input provided' });
    }

    if (text.length > 4096) {
        return res.status(400).json({ success: false, error: 'Terminal input is too long' });
    }

    execFile('tmux', ['send-keys', '-t', TMUX_TARGET, '-l', '--', text], { timeout: 3000 }, (err) => {
        if (err) {
            console.error(`Failed to insert terminal input into ${TMUX_TARGET}:`, err.message);
            return res.status(502).json({
                success: false,
                error: 'Failed to insert text into terminal session'
            });
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

// Serve static files (HTML interface) - MUST be after API routes
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
    console.log(`tmux input target: ${TMUX_TARGET}`);
    console.log(`Terminal proxy available at /terminal/`);
});
