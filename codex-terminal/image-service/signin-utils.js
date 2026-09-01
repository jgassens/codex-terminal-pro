'use strict';

// Helpers for surfacing consultant sign-in links from the terminal pane.
//
// Consultant CLIs (Claude Code, Kimi Code) authenticate with OAuth, but this
// add-on is ingress-only and can never receive a browser callback. The user
// therefore has to open a URL the CLI prints into the terminal, which the web
// terminal renders as unselectable wrapped text. These helpers recover that
// URL so the UI can present it as a real link.

// Deliberately strict: agent CLIs also print documentation links (Claude
// Code's post-login screen shows code.claude.com/docs/en/security), and a
// docs URL popping up as a "sign-in link" reads like a phishing prompt.
const SIGN_IN_URL_HINT = /oauth|authorize|login|device|activate|verify|\bauth\./i;
const NON_SIGN_IN_URL = /\/docs\/|\/help\/|(^|\/\/)(docs|help|support)\./i;
const URL_CHAR = /[^\s"'`<>\])]/;
// One or more printable, non-space characters: a URL can wrap so that its
// final fragment is a single character, and dropping it truncates the link.
const CONTINUATION_LINE = /^[!-~]+$/;

// A TUI hard-wraps a long URL at exactly the pane's width, so "this line is
// wrapped" means "this line fills the pane", not any fixed number: the shared
// tmux window resizes to whichever viewer is active, so a phone renders the
// same URL as many ~45-column fragments while a desktop uses two long ones.
// Real newlines are involved, so `capture-pane -J` cannot rejoin them.
// Without a measured width, fall back to the longest line in the capture.
function mergeHardWrappedLines(paneText, paneWidth) {
    const lines = paneText.split('\n');
    const measured = Number.isInteger(paneWidth) && paneWidth > 10
        ? paneWidth
        : lines.reduce((max, line) => Math.max(max, line.trimEnd().length), 0);
    const wrapThreshold = Math.max(20, measured - 1);
    const merged = [];
    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const prev = merged.length > 0 ? merged[merged.length - 1] : null;
        if (
            prev !== null &&
            prev.length >= wrapThreshold &&
            /https:\/\/\S+$/.test(prev) &&
            URL_CHAR.test(prev.slice(-1)) &&
            CONTINUATION_LINE.test(line) &&
            !line.startsWith('https://') &&
            prev.length + line.length < 4000
        ) {
            merged[merged.length - 1] = prev + line;
        } else {
            merged.push(line);
        }
    }
    return merged.join('\n');
}

function extractSignInUrl(paneText, options = {}) {
    if (typeof paneText !== 'string' || paneText === '') {
        return null;
    }
    const matches = mergeHardWrappedLines(paneText, options.paneWidth).match(/https:\/\/[^\s"'`<>\])]+/g);
    if (!matches) {
        return null;
    }
    const cleaned = matches.map((url) => url.replace(/[.,;:!?]+$/, ''));
    const authish = cleaned.filter((url) =>
        SIGN_IN_URL_HINT.test(url) && !NON_SIGN_IN_URL.test(url));
    if (authish.length === 0) {
        // No fallback to "any URL on screen": better to show nothing than
        // to present a random link as a sign-in prompt.
        return null;
    }
    return authish[authish.length - 1];
}

// A sign-in URL's own host is the honest attribution for who is asking.
const SIGN_IN_HOST_LABELS = [
    { pattern: /(^|\.)claude\.com$|(^|\.)anthropic\.com$/, label: 'Claude Code' },
    { pattern: /(^|\.)openai\.com$|(^|\.)chatgpt\.com$/, label: 'Codex' },
    { pattern: /(^|\.)kimi\.(ai|com)$|(^|\.)moonshot\.(ai|cn)$/, label: 'Kimi Code' }
];

function signInUrlLabel(url) {
    try {
        const host = new URL(url).hostname;
        const match = SIGN_IN_HOST_LABELS.find((entry) => entry.pattern.test(host));
        return match ? match.label : null;
    } catch {
        return null;
    }
}

// The terminal pane runs a chain of wrapper shells (tmux launch script ->
// session picker -> auth helper) below which the CLI runs. Cancelling a
// sign-in must terminate only the CLI: these are the argv shapes of our own
// wrapper layers, matched on full args because bash reports the script name
// (not "bash") as its comm.
const WRAPPER_PROCESS_PATTERNS = [
    /(^|\/)(ba)?sh$/,
    /(^|\/)(ba)?sh\s+-l\b/,
    /codex-terminal-launch\.sh/,
    /codex-session-picker/,
    /claude-auth-helper/,
    /kimi-auth-helper/,
    /codex-auth-helper/
];

function isSignInWrapperProcess(args) {
    if (typeof args !== 'string' || args.trim() === '') {
        return false;
    }
    return WRAPPER_PROCESS_PATTERNS.some((pattern) => pattern.test(args.trim()));
}

// An allowlisted URL is not proof that a login is active: an ordinary
// program (including the agent itself) can print one. Attribute the live
// non-wrapper process independently and require both sources to agree before
// the UI offers the URL or a destructive Cancel action.
function signInProcessLabel(args) {
    const command = String(args || '').trim();
    if (!command) {
        return null;
    }

    const first = command.split(/\s+/, 1)[0].split('/').pop();
    if (
        first === 'codex' &&
        /(?:^|\s)login(?:\s|$)/.test(command)
    ) {
        return 'Codex';
    }
    if (
        first === 'claude' ||
        /@anthropic-ai\/claude-code|(?:^|\/)claude(?:\.js)?(?:\s|$)/.test(command)
    ) {
        return 'Claude Code';
    }
    if (
        /(?:^|\s)login(?:\s|$)/.test(command) &&
        (
            first === 'kimi' ||
            /@moonshot-ai\/kimi-code|(?:^|\/)kimi(?:\.js)?(?:\s|$)/.test(command)
        )
    ) {
        return 'Kimi Code';
    }
    return null;
}

// Codex's browser-flow login redirects to a listener on the CLI's own
// loopback. The pinned CLI prefers 1455 and falls back to 1457 when that port
// remains occupied. From the user's browser either address is a dead end, so
// the pasted URL can instead be delivered to the listener in the container.
// Only those two ports and the exact callback path are forwardable.
const LOOPBACK_CALLBACK = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(1455|1457)(\/auth\/callback)\?(\S+)$/i;

function parseLoopbackCallback(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const match = text.trim().match(LOOPBACK_CALLBACK);
    if (!match) {
        return null;
    }
    const [, port, path, query] = match;
    if (/[\s<>"'`]/.test(query)) {
        return null;
    }
    return { port: Number(port), path, query };
}

module.exports = {
    extractSignInUrl,
    isSignInWrapperProcess,
    parseLoopbackCallback,
    signInProcessLabel,
    signInUrlLabel
};
