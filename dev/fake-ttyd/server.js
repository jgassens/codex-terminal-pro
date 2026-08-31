'use strict';
// Minimal stand-in for ttyd 1.7.7: serves a page with a real xterm exposing
// window.term, enough for the add-on frontend's iframe integration.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.FAKE_TTYD_PORT || 7681);
const XTERM = path.join(__dirname, 'node_modules', '@xterm', 'xterm');

const routes = {
    '/xterm.js': { file: path.join(XTERM, 'lib', 'xterm.js'), type: 'text/javascript' },
    '/xterm.css': { file: path.join(XTERM, 'css', 'xterm.css'), type: 'text/css' }
};

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    // The page is served behind the image-service's /terminal proxy, so asset
    // requests can arrive with any prefix; match by suffix.
    const suffix = Object.keys(routes).find((key) => url.endsWith(key));
    if (suffix) {
        const route = routes[suffix];
        res.writeHead(200, { 'Content-Type': route.type });
        fs.createReadStream(route.file).pipe(res);
        return;
    }
    if (url === '/token' || url.endsWith('/token')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: '' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`fake-ttyd on ${PORT}`));
