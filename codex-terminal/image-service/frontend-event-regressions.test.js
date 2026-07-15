'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

test('image drops have one upload listener and stop bubbling after it claims the event', () => {
    assert.doesNotMatch(html, /dropZone\.addEventListener\('drop', handleImageDrop\)/);
    assert.match(html, /document\.addEventListener\('drop', handleImageDrop\)/);

    const start = html.indexOf('async function handleImageDrop(e)');
    const end = html.indexOf("document.addEventListener('drop', handleImageDrop)", start);
    assert.ok(start >= 0 && end > start);
    assert.match(html.slice(start, end), /e\.stopPropagation\(\)/);
});
