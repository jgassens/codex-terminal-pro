'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBoundedSingleFlight } = require('./bounded-single-flight');

test('same-key callers share one running operation', async () => {
    const work = createBoundedSingleFlight();
    let calls = 0;
    let release;
    const task = () => {
        calls += 1;
        return new Promise((resolve) => { release = resolve; });
    };
    const first = work.run('settings', task);
    const second = work.run('settings', task);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release('done');
    assert.deepEqual(await Promise.all([first, second]), ['done', 'done']);
});

test('different keys run serially and subsequent work is released', async () => {
    const work = createBoundedSingleFlight({ maxPending: 2 });
    const events = [];
    let release;
    const first = work.run('one', () => new Promise((resolve) => {
        events.push('one-start');
        release = () => { events.push('one-end'); resolve(1); };
    }));
    const second = work.run('two', async () => {
        events.push('two');
        return 2;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['one-start']);
    release();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(events, ['one-start', 'one-end', 'two']);
});

test('excess distinct work is rejected before its task runs', async () => {
    const work = createBoundedSingleFlight({ maxPending: 1 });
    let release;
    const first = work.run('one', () => new Promise((resolve) => { release = resolve; }));
    work.run('two', async () => 2);
    let ran = false;
    await assert.rejects(
        work.run('three', async () => { ran = true; }),
        (error) => error.code === 'READ_WORK_FULL'
    );
    assert.equal(ran, false);
    release(1);
    await first;
});

test('a queued flight expires without running and its key can be retried', async () => {
    const work = createBoundedSingleFlight({ maxPending: 2, maxWaitMs: 5 });
    let release;
    const first = work.run('one', () => new Promise((resolve) => { release = resolve; }));
    let expiredRan = false;
    await assert.rejects(
        work.run('two', async () => { expiredRan = true; }),
        (error) => error.code === 'READ_WORK_WAIT_TIMEOUT'
    );
    assert.equal(expiredRan, false);
    assert.equal(work.inFlight('two'), false);

    release(1);
    await first;
    assert.equal(await work.run('two', async () => 2), 2);
});

test('a rejected running flight releases the global slot', async () => {
    const work = createBoundedSingleFlight();
    await assert.rejects(work.run('one', async () => {
        throw new Error('failed');
    }), /failed/);
    assert.equal(work.inFlight('one'), false);
    assert.equal(await work.run('two', async () => 'recovered'), 'recovered');
});
