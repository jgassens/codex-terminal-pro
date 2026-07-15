'use strict';

function endChildStdin(stream, text, onError) {
    let handled = false;
    const handleError = (err) => {
        if (handled) {
            return;
        }
        handled = true;
        onError(err);
    };

    // A child can exit after spawn succeeds but before it reads stdin. Without
    // this listener, Node treats the resulting EPIPE as an uncaught exception.
    stream.once('error', handleError);
    try {
        stream.end(text);
    } catch (err) {
        handleError(err);
    }
}

module.exports = { endChildStdin };
