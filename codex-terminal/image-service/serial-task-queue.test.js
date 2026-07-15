'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSerialTaskQueue } = require('./serial-task-queue');

test('queued tasks never overlap and callbacks preserve request order', async () => {
    const queue = createSerialTaskQueue({ maxPending: 4 });
    const events = [];
    let active = 0;
    let maximumActive = 0;

    await new Promise((resolve, reject) => {
        let completed = 0;
        for (const id of [1, 2, 3]) {
            queue.enqueue((done) => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                events.push(`start-${id}`);
                setTimeout(() => {
                    events.push(`end-${id}`);
                    active -= 1;
                    done(null, id);
                }, 5);
            }, (err, result) => {
                if (err) {
                    reject(err);
                    return;
                }
                events.push(`callback-${result}`);
                completed += 1;
                if (completed === 3) {
                    resolve();
                }
            });
        }
    });

    assert.equal(maximumActive, 1);
    assert.deepEqual(events, [
        'start-1', 'end-1', 'callback-1',
        'start-2', 'end-2', 'callback-2',
        'start-3', 'end-3', 'callback-3'
    ]);
});

test('queue rejects excess pending work without disturbing the running task', async () => {
    const queue = createSerialTaskQueue({ maxPending: 1 });
    let finishFirst;
    const first = new Promise((resolve) => {
        queue.enqueue((done) => {
            finishFirst = () => done(null, 'first');
        }, (err, value) => {
            assert.ifError(err);
            assert.equal(value, 'first');
            resolve();
        });
    });

    queue.enqueue((done) => done(null, 'second'), () => {});
    let overflowError;
    const accepted = queue.enqueue((done) => done(null, 'third'), (err) => {
        overflowError = err;
    });

    assert.equal(accepted, false);
    assert.equal(overflowError?.code, 'QUEUE_FULL');
    finishFirst();
    await first;
});

test('a poisoned task rejects queued and future work without executing it', () => {
    const queue = createSerialTaskQueue({ maxPending: 4 });
    let finishFirst;
    let queuedExecuted = false;
    const errors = [];

    queue.enqueue((done) => {
        finishFirst = done;
    }, (err) => errors.push(err));
    queue.enqueue((done) => {
        queuedExecuted = true;
        done();
    }, (err) => errors.push(err));

    const fatal = new Error('shell isolation failed');
    fatal.poisonQueue = true;
    finishFirst(fatal);

    const futureAccepted = queue.enqueue(() => {
        queuedExecuted = true;
    }, (err) => errors.push(err));

    assert.equal(queue.poisoned(), true);
    assert.equal(queuedExecuted, false);
    assert.equal(futureAccepted, false);
    assert.equal(errors.length, 3);
    assert.ok(errors.every((error) => error === fatal));
});

test('a queued task expires instead of executing after its client budget', async () => {
    const queue = createSerialTaskQueue({ maxPending: 2, maxWaitMs: 5 });
    let finishFirst;
    let expiredExecuted = false;

    queue.enqueue((done) => {
        finishFirst = done;
    }, () => {});

    const error = await new Promise((resolve) => {
        queue.enqueue((done) => {
            expiredExecuted = true;
            done();
        }, (err) => resolve(err));
    });

    assert.equal(error?.code, 'QUEUE_WAIT_TIMEOUT');
    assert.equal(expiredExecuted, false);
    finishFirst();
});

test('disconnecting a queued task cancels it before execution', () => {
    const queue = createSerialTaskQueue({ maxPending: 2 });
    const controller = new AbortController();
    let finishFirst;
    let canceledExecuted = false;
    let cancellationError;

    queue.enqueue((done) => {
        finishFirst = done;
    }, () => {});
    queue.enqueue((done) => {
        canceledExecuted = true;
        done();
    }, (err) => {
        cancellationError = err;
    }, { signal: controller.signal });

    controller.abort();
    finishFirst();
    assert.equal(cancellationError?.code, 'QUEUE_CANCELED');
    assert.equal(canceledExecuted, false);
});
