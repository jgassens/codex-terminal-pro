'use strict';

function createSerialTaskQueue(options = {}) {
    const maxPending = Math.max(1, options.maxPending ?? 8);
    const maxWaitMs = Math.max(0, options.maxWaitMs ?? 0);
    const pending = [];
    let running = false;
    let poisonError = null;

    function rejectPending(error) {
        while (pending.length > 0) {
            pending.shift().callback(error);
        }
    }

    function drain() {
        if (running || pending.length === 0) {
            return;
        }

        running = true;
        const task = pending.shift();
        if (task.timer) {
            clearTimeout(task.timer);
        }
        task.signal?.removeEventListener('abort', task.abort);
        let completed = false;
        const done = (...args) => {
            if (completed) {
                return;
            }
            completed = true;
            running = false;
            try {
                task.callback(...args);
            } finally {
                const error = args[0];
                if (error?.poisonQueue) {
                    poisonError = error;
                    rejectPending(error);
                } else {
                    drain();
                }
            }
        };

        try {
            task.execute(done);
        } catch (err) {
            done(err);
        }
    }

    function enqueue(execute, callback, taskOptions = {}) {
        if (poisonError) {
            callback(poisonError);
            return false;
        }

        if (running && pending.length >= maxPending) {
            const err = new Error('Raw shell command queue is full');
            err.code = 'QUEUE_FULL';
            callback(err);
            return false;
        }

        const task = {
            execute,
            callback,
            signal: taskOptions.signal,
            abort: null,
            timer: null
        };

        const rejectWhilePending = (error) => {
            const index = pending.indexOf(task);
            if (index === -1) {
                return;
            }
            pending.splice(index, 1);
            if (task.timer) {
                clearTimeout(task.timer);
            }
            task.signal?.removeEventListener('abort', task.abort);
            callback(error);
        };

        task.abort = () => {
            const error = new Error('Queued raw shell command was canceled');
            error.code = 'QUEUE_CANCELED';
            rejectWhilePending(error);
        };
        if (task.signal?.aborted) {
            const error = new Error('Queued raw shell command was canceled');
            error.code = 'QUEUE_CANCELED';
            callback(error);
            return false;
        }

        pending.push(task);
        if (task.signal) {
            task.signal.addEventListener('abort', task.abort, { once: true });
        }
        if (running && maxWaitMs > 0) {
            task.timer = setTimeout(() => {
                const error = new Error('Queued raw shell command waited too long');
                error.code = 'QUEUE_WAIT_TIMEOUT';
                rejectWhilePending(error);
            }, maxWaitMs);
            task.timer.unref?.();
        }
        drain();
        return true;
    }

    return {
        enqueue,
        size: () => pending.length + Number(running),
        poisoned: () => Boolean(poisonError)
    };
}

module.exports = { createSerialTaskQueue };
