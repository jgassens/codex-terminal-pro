'use strict';

function createBoundedSingleFlight(options = {}) {
    const maxPending = Math.max(1, options.maxPending ?? 8);
    const maxWaitMs = Math.max(0, options.maxWaitMs ?? 5000);
    const pending = [];
    const flights = new Map();
    let running = false;

    function drain() {
        if (running || pending.length === 0) {
            return;
        }
        running = true;
        const entry = pending.shift();
        clearTimeout(entry.timer);
        const complete = (failed, result) => {
            running = false;
            if (flights.get(entry.key) === entry.promise) {
                flights.delete(entry.key);
            }
            drain();
            if (failed) {
                entry.reject(result);
            } else {
                entry.resolve(result);
            }
        };
        Promise.resolve()
            .then(entry.task)
            .then(
                (value) => complete(false, value),
                (error) => complete(true, error)
            );
    }

    function run(key, task) {
        if (flights.has(key)) {
            return flights.get(key);
        }
        if (running && pending.length >= maxPending) {
            const error = new Error('Bounded read-work queue is full');
            error.code = 'READ_WORK_FULL';
            return Promise.reject(error);
        }

        let resolveEntry;
        let rejectEntry;
        const promise = new Promise((resolve, reject) => {
            resolveEntry = resolve;
            rejectEntry = reject;
        });
        const entry = {
            key,
            task,
            resolve: resolveEntry,
            reject: rejectEntry,
            timer: null,
            promise
        };
        flights.set(key, promise);
        pending.push(entry);
        if (running && maxWaitMs > 0) {
            entry.timer = setTimeout(() => {
                const index = pending.indexOf(entry);
                if (index === -1) {
                    return;
                }
                pending.splice(index, 1);
                flights.delete(key);
                const error = new Error('Bounded read work waited too long');
                error.code = 'READ_WORK_WAIT_TIMEOUT';
                rejectEntry(error);
            }, maxWaitMs);
            entry.timer.unref?.();
        }
        drain();
        return promise;
    }

    return {
        run,
        size: () => pending.length + Number(running),
        inFlight: (key) => flights.has(key)
    };
}

module.exports = { createBoundedSingleFlight };
