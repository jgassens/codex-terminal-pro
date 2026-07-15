'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
    } catch {
        // Some filesystems do not allow directory fsync. The file itself was
        // still fsynced and renamed atomically in the same directory.
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

function writeFileAtomic(filePath, content, options = {}) {
    const mode = options.mode ?? 0o600;
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    let fd;

    try {
        fd = fs.openSync(temporaryPath, 'wx', mode);
        fs.writeFileSync(fd, content, { encoding: options.encoding || 'utf8' });
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, mode);
        fsyncDirectory(directory);
    } catch (err) {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch {
                // Preserve the original write error.
            }
        }
        try {
            fs.unlinkSync(temporaryPath);
        } catch {
            // The rename may already have completed, or the temp file may not exist.
        }
        throw err;
    }
}

function readFileTail(filePath, maxBytes) {
    const stat = fs.statSync(filePath);
    const bytesToRead = Math.min(stat.size, Math.max(1, maxBytes));
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');

    try {
        fs.readSync(fd, buffer, 0, bytesToRead, start);
    } finally {
        fs.closeSync(fd);
    }

    let text = buffer.toString('utf8');
    if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return text;
}

function parseJsonLinesTail(filePath, options = {}) {
    const maxBytes = options.maxBytes ?? (2 * 1024 * 1024);
    const limit = Math.max(1, options.limit ?? 48);
    return readFileTail(filePath, maxBytes)
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
            try {
                const parsed = JSON.parse(line);
                return parsed && typeof parsed === 'object' ? [parsed] : [];
            } catch {
                return [];
            }
        })
        .slice(-limit);
}

module.exports = {
    parseJsonLinesTail,
    readFileTail,
    writeFileAtomic
};
