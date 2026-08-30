'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    extractSignInUrl,
    isSignInWrapperProcess,
    parseLoopbackCallback,
    signInUrlLabel
} = require('./signin-utils');

test('extractSignInUrl finds a sign-in link that fits on one line', () => {
    const pane = [
        'Welcome to Claude Code v2.1.251',
        '',
        " Browser didn't open? Use the url below to sign in (c to copy)",
        '',
        'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code_challenge=xyz',
        '',
        ' Paste code here if prompted >'
    ].join('\n');
    assert.equal(
        extractSignInUrl(pane),
        'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code_challenge=xyz'
    );
});

test('extractSignInUrl stitches a URL hard-wrapped by the TUI back together', () => {
    // Verbatim shape from Claude Code's login screen in a 163-column pane.
    const pane = [
        " Browser didn't open? Use the url below to sign in (c to copy)",
        '',
        'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2',
        'Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challe',
        'nge=wa5MAantKV5cq4R1JHeoLf8oL82_sI1GDjsAzXoKH3I&code_challenge_method=S256&state=XujCttNHhAGAy7iB_-Cj_ZOZSTGpI4QxgYL15c1XqfI',
        '',
        ' Paste code here if prompted >'
    ].join('\n');
    const url = extractSignInUrl(pane);
    assert.equal(/\s/.test(url), false);
    assert.equal(url.startsWith('https://claude.com/cai/oauth/authorize?code=true'), true);
    assert.equal(url.endsWith('state=XujCttNHhAGAy7iB_-Cj_ZOZSTGpI4QxgYL15c1XqfI'), true);
    assert.equal(url.includes('platform.claude.com%2Foauth%2Fcode%2Fcallback'), true);
});

test('extractSignInUrl reassembles wraps at any pane width', () => {
    const fullUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=QQ9oV67n-tnORzuEXDuLIeDCg5aOzRWRlJ3mTkwb0ns&state=mXn29yz_b1Vy0RhK4Qyq0Wsy6i8ujI5PvP5hNZo2vD0';
    for (const width of [45, 60, 100, 163, 240]) {
        const chunks = [];
        for (let i = 0; i < fullUrl.length; i += width) {
            chunks.push(fullUrl.slice(i, i + width));
        }
        const pane = ['Welcome to Claude Code', '', ...chunks, '', ' Paste code here >'].join('\n');
        assert.equal(extractSignInUrl(pane, { paneWidth: width }), fullUrl, `width ${width}`);
    }
});

test('extractSignInUrl keeps a single-character final wrapped fragment', () => {
    // A URL whose length is one past a multiple of the pane width wraps to a
    // last line of exactly one character; that character must not be dropped.
    const width = 40;
    let fullUrl = 'https://claude.com/cai/oauth/authorize?code=true&state=';
    while (fullUrl.length % width !== 0) {
        fullUrl += 'a';
    }
    fullUrl += 'Z';
    const chunks = [];
    for (let i = 0; i < fullUrl.length; i += width) {
        chunks.push(fullUrl.slice(i, i + width));
    }
    assert.equal(chunks[chunks.length - 1], 'Z', 'last fragment should be one char');
    const pane = ['Welcome to Claude Code', '', ...chunks, '', ' Paste code here >'].join('\n');
    assert.equal(extractSignInUrl(pane, { paneWidth: width }), fullUrl);
});

test('extractSignInUrl ignores documentation links on post-login screens', () => {
    // Claude Code's security-notes screen after a successful sign-in: this
    // must not be mistaken for a pending authorization prompt.
    const pane = [
        ' Claude Code v2.1.251',
        ' Security notes:',
        ' Due to prompt injection risks, only use it with code you trust',
        ' For more details see https://code.claude.com/docs/en/security',
        ' Press Enter to continue'
    ].join('\n');
    assert.equal(extractSignInUrl(pane), null);
    assert.equal(extractSignInUrl('Read https://docs.example.com/login-help for tips'), null);
    assert.equal(extractSignInUrl('See https://example.com/changelog for updates'), null);
});

test('extractSignInUrl rejects non-https and empty input', () => {
    assert.equal(extractSignInUrl('Go to https://auth.example.com/login.'), 'https://auth.example.com/login');
    assert.equal(extractSignInUrl('http://insecure.example.com/login'), null);
    assert.equal(extractSignInUrl('no links here'), null);
    assert.equal(extractSignInUrl(''), null);
    assert.equal(extractSignInUrl(undefined), null);
});

test('extractSignInUrl takes the newest candidate when several match', () => {
    const pane = [
        'https://auth.example.com/device/old',
        'retrying...',
        'https://auth.example.com/device/new'
    ].join('\n');
    assert.equal(extractSignInUrl(pane), 'https://auth.example.com/device/new');
});

test('signInUrlLabel attributes a sign-in URL by its host', () => {
    assert.equal(signInUrlLabel('https://claude.com/cai/oauth/authorize?x=1'), 'Claude Code');
    assert.equal(signInUrlLabel('https://auth.openai.com/codex/device'), 'Codex');
    assert.equal(signInUrlLabel('https://www.kimi.ai/code/authorize_device?user_code=WWNB'), 'Kimi Code');
    assert.equal(signInUrlLabel('https://www.kimi.com/device'), 'Kimi Code');
    assert.equal(signInUrlLabel('https://example.com/login'), null);
    assert.equal(signInUrlLabel('not a url'), null);
});

test('isSignInWrapperProcess separates wrapper layers from the CLI itself', () => {
    assert.equal(isSignInWrapperProcess('/usr/bin/bash /tmp/codex-terminal-launch.sh'), true);
    assert.equal(isSignInWrapperProcess('/bin/bash /usr/local/bin/codex-session-picker'), true);
    assert.equal(isSignInWrapperProcess('/bin/bash /usr/local/bin/claude-auth-helper'), true);
    assert.equal(isSignInWrapperProcess('/bin/bash /usr/local/bin/kimi-auth-helper'), true);
    assert.equal(isSignInWrapperProcess('bash'), true);
    assert.equal(isSignInWrapperProcess('/bin/bash -l'), true);
    assert.equal(isSignInWrapperProcess('/usr/local/bin/claude'), false);
    assert.equal(isSignInWrapperProcess('node /usr/local/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs login'), false);
    assert.equal(isSignInWrapperProcess('codex login --device-auth'), false);
    assert.equal(isSignInWrapperProcess(''), false);
});

test('parseLoopbackCallback accepts only the fixed Codex callback shape', () => {
    assert.deepEqual(
        parseLoopbackCallback('http://localhost:1455/auth/callback?code=ac_abc.def-ghi&state=xyz'),
        { port: 1455, path: '/auth/callback', query: 'code=ac_abc.def-ghi&state=xyz' }
    );
    assert.notEqual(parseLoopbackCallback('localhost:1455/auth/callback?code=x&state=y'), null);
    assert.notEqual(parseLoopbackCallback('https://127.0.0.1:1455/auth/callback?code=x'), null);
    assert.equal(parseLoopbackCallback('http://localhost:9999/auth/callback?code=x'), null);
    assert.equal(parseLoopbackCallback('http://localhost:1455/other/path?code=x'), null);
    assert.equal(parseLoopbackCallback('http://evil.example.com:1455/auth/callback?code=x'), null);
    assert.equal(parseLoopbackCallback('http://localhost:1455/auth/callback?code=x&i="<script>'), null);
    assert.equal(parseLoopbackCallback('just some text'), null);
    assert.equal(parseLoopbackCallback(undefined), null);
});
