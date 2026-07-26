'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const serverPath = path.join(__dirname, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

function extractFunction(name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notStrictEqual(start, -1, `missing ${name}`);

    const openBrace = source.indexOf('{', start);
    let depth = 0;
    for (let index = openBrace; index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
        } else if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`unterminated function ${name}`);
}

function loadFunction(name) {
    const context = vm.createContext({});
    vm.runInContext(`${extractFunction(name)}\nthis.${name} = ${name};`, context);
    return context[name];
}

test('countTmuxClients counts one attached client per non-empty line', () => {
    const countTmuxClients = loadFunction('countTmuxClients');

    assert.equal(countTmuxClients('/dev/pts/0\n'), 1);
    assert.equal(countTmuxClients('/dev/pts/0\n/dev/pts/1\n'), 2);
    assert.equal(countTmuxClients('/dev/pts/0\n/dev/pts/1\n/dev/pts/3\n'), 3);
});

test('countTmuxClients treats no clients and blank output as zero', () => {
    const countTmuxClients = loadFunction('countTmuxClients');

    assert.equal(countTmuxClients(''), 0);
    assert.equal(countTmuxClients('\n\n'), 0);
    assert.equal(countTmuxClients('   \n \n'), 0);
    assert.equal(countTmuxClients(null), 0);
    assert.equal(countTmuxClients(undefined), 0);
});

test('countTmuxClients ignores trailing whitespace and a missing final newline', () => {
    const countTmuxClients = loadFunction('countTmuxClients');

    assert.equal(countTmuxClients('/dev/pts/0'), 1);
    assert.equal(countTmuxClients('/dev/pts/0  \n  /dev/pts/1  '), 2);
});
