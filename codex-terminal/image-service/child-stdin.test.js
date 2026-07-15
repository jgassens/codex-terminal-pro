'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { endChildStdin } = require('./child-stdin');

test('an asynchronous EPIPE is converted into the caller error path', () => {
    const stream = new EventEmitter();
    const expected = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    let received = null;
    stream.end = () => stream.emit('error', expected);

    endChildStdin(stream, 'large prompt', (err) => {
        received = err;
    });

    assert.equal(received, expected);
});

test('a synchronous stdin failure is reported exactly once', () => {
    const stream = new EventEmitter();
    const expected = new Error('already closed');
    let calls = 0;
    stream.end = () => {
        throw expected;
    };

    endChildStdin(stream, 'text', (err) => {
        calls += 1;
        assert.equal(err, expected);
    });
    stream.emit('error', new Error('late error'));

    assert.equal(calls, 1);
});
