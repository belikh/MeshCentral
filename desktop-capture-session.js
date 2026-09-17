'use strict';

/**
 * @description Capture lifecycle shared by the MeshCentral desktop tools and
 * the desktop session cache.
 *
 * A launched relay session owns a capture viewer: both the one-shot tools
 * (snapshot and input) and the session cache attach the viewer built from the
 * session's captureConfig, start it, and release the session when done. This
 * module holds that shape in one place, so attach, start and release change
 * for one reason. releaseSession never throws, synchronously or
 * asynchronously: closing a socket can fail and that must not break eviction
 * or a finally block.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

function settle(promise) {
    if (promise == null) { return Promise.resolve(); }
    return Promise.resolve(promise).catch(() => { });
}

// Release a session without ever throwing, synchronously or asynchronously:
// closing a socket can fail and that must not break the caller.
async function releaseSession(session) {
    try {
        await settle(session.release());
    } catch (error) {
        // A synchronous throw from release() is settled like a rejection.
    }
}

/**
* Attach the viewer built from the session's captureConfig and start it.
* Resolves with the started capture. The caller owns releasing the session:
* the tools release around the call, the cache keeps it until it idles out, so
* a failed start is released by the caller's own failure path.
*/
async function startSessionCapture(session, createCapture) {
    const capture = session.attach(createCapture(session.captureConfig));
    await capture.start();
    return capture;
}

module.exports = {
    startSessionCapture: startSessionCapture,
    releaseSession: releaseSession
};
