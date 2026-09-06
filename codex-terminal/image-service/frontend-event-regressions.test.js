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

test('every origin-protected browser route uses the ingress request marker', () => {
    const guardedRoutes = [
        'change-desk/summary',
        'change-desk/report',
        'change-desk/mall-cop',
        'terminal-mode',
        'upload',
        'terminal-input',
        'terminal-paste',
        'terminal-shell-command',
        'terminal-control'
    ];

    for (const route of guardedRoutes) {
        assert.match(html, new RegExp(`protectedIngressFetch\\('${route}'`));
        assert.doesNotMatch(html, new RegExp(`fetch\\(ingressPath\\('${route}'\\)`));
    }

    const wrapperStart = html.indexOf('function protectedIngressFetch(path, options = {})');
    const wrapperEnd = html.indexOf('// Fetch configuration and load ttyd', wrapperStart);
    assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart);
    const wrapper = html.slice(wrapperStart, wrapperEnd);
    assert.match(wrapper, /new Headers\(options\.headers \|\| undefined\)/);
    assert.match(wrapper, /headers\.set\('X-Codex-Terminal-Request', '1'\)/);
    assert.doesNotMatch(wrapper, /Content-Type/i);

    const uploadStart = html.indexOf('async function uploadImage(file)');
    const uploadEnd = html.indexOf('async function handleImagePaste(e)', uploadStart);
    const upload = html.slice(uploadStart, uploadEnd);
    assert.match(upload, /protectedIngressFetch\('upload'/);
    assert.doesNotMatch(upload, /Content-Type/i);
});

test('consultant settings explain defaults and an empty signed-in model catalog', () => {
    assert.match(html, /\? `Default \(\$\{consultant\.defaultModel\}\)`/);
    assert.match(html, /\? `Default \(\$\{consultant\.defaultEffort\}\)`/);
    const modelSettingsStart = html.indexOf('const available = consultant.models || []');
    const modelSettingsEnd = html.indexOf('const modelSelect = document.createElement', modelSettingsStart);
    assert.ok(modelSettingsStart >= 0 && modelSettingsEnd > modelSettingsStart);
    const modelSettings = html.slice(modelSettingsStart, modelSettingsEnd);
    assert.match(modelSettings, /if \(consultant\.defaultModel\)[\s\S]*`Default is \$\{consultant\.defaultModel\} at \$\{consultant\.defaultEffort\}`/);
    // The empty-list explanation is appended, never displaced by a declared
    // default, and keys on readiness so a signed-in Kimi with no registered
    // models is still told to finish sign-in.
    assert.match(modelSettings, /if \(!available\.length\)[\s\S]*consultant\.ready\s*\? 'no model list yet; run this consultant once or enter a model id'\s*:\s*'no models available until sign-in finishes'/);
    assert.doesNotMatch(modelSettings, /consultant\.signedIn/);

    const effortLevelsStart = html.indexOf('function effortLevelsFor(consultant, model)');
    const effortLevelsEnd = html.indexOf('function renderConsultantRow(consultant)', effortLevelsStart);
    assert.ok(effortLevelsStart >= 0 && effortLevelsEnd > effortLevelsStart);
    const effortLevels = html.slice(effortLevelsStart, effortLevelsEnd);
    assert.match(effortLevels, /hasOwnProperty\.call\(byModel, model\)/);
    assert.match(effortLevels, /hasOwnProperty\.call\(byModel, ''\)/);
    assert.match(effortLevels, /return byModel\[''\] \|\| \[\]/);
});
