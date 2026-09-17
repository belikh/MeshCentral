'use strict';

/**
* @description Short-lived cache of MeshCentral desktop relay sessions.
*
* A desktop relay session is expensive to negotiate, so poll and input loops
* should reuse one session instead of reconnecting for every call. This module
* owns that lifecycle: it launches a session for a key on first use, hands the
* same entry back while the capture stays alive, evicts entries whose capture
* closes, closes entries that sit idle past an idle timeout, and closes every
* remaining entry when the process exits. A launch that fails after the relay
* session was opened releases it, so a failure never leaks a session or leaves
* a stale entry behind.
*
* The cache is keyed by an opaque string; the tool layer uses the device id so
* the frame, poll and (later) input tools share one session per device. It is
* injectable end to end (client, capture factory, clock, lifecycle emitter) so
* tests run with no sockets and no live server.
*
* Entry: { key, session, capture, inUse, lastUsed }. Callers hold an entry for
* the duration of a call and finish() it afterwards; finish() leaves the entry
* cached and starts its idle window. release() closes it immediately.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { DesktopCapture } = require('./desktopcapture.js');
const { startSessionCapture, releaseSession } = require('./desktop-capture-session.js');

const DEFAULT_IDLE_TIMEOUT = 30000;

function isCaptureClosed(capture) {
    return (capture != null) && (capture.state === 'closed');
}

class DesktopSessionCache {
    /**
    * Options:
    *   client         Required. A connected MeshCentralClient or compatible.
    *   createCapture  (config) => capture, defaults to a real DesktopCapture.
    *   idleTimeout    Milliseconds an entry may sit unused before it is closed.
    *                  Defaults to DEFAULT_IDLE_TIMEOUT; 0 or less disables
    *                  idle eviction.
    *   lifecycle      process-like emitter carrying 'exit'. Defaults to
    *                  process; pass null to disable the exit hook.
    *   now            Clock in milliseconds, Date.now by default.
    */
    constructor(options) {
        options = options || {};
        if (options.client == null) { throw new TypeError('DesktopSessionCache requires a client.'); }
        this._client = options.client;
        this._createCapture = (typeof options.createCapture === 'function')
            ? options.createCapture
            : (config) => new DesktopCapture(config);
        let idleTimeout = DEFAULT_IDLE_TIMEOUT;
        if (options.idleTimeout !== undefined) {
            const value = Number(options.idleTimeout);
            idleTimeout = (Number.isFinite(value) && (value > 0)) ? Math.floor(value) : 0;
        }
        this._idleTimeout = idleTimeout;
        this._lifecycle = (options.lifecycle === undefined) ? process : options.lifecycle;
        this._now = (typeof options.now === 'function') ? options.now : () => Date.now();
        this._entries = new Map();
        this._pending = new Map();
        this._closed = false;
        this._exitAttached = false;
        this._exitHook = () => { void this.closeAll(); };
    }

    /** Number of sessions currently cached. */
    get size() { return this._entries.size; }

    /** Configured idle timeout in milliseconds; 0 means no idle eviction. */
    get idleTimeout() { return this._idleTimeout; }

    /** The cached entry for a key, or null. Never launches anything. */
    peek(key) {
        return this._entries.get(key) || null;
    }

    /**
    * Return the cached entry for a key, launching a session when none is
    * cached or the cached capture has closed. The entry is marked in use until
    * finish() or release() is called, which protects it from idle eviction.
    */
    async acquire(key, options) {
        if ((typeof key !== 'string') || (key.length === 0)) {
            throw new TypeError('DesktopSessionCache keys must be non-empty strings.');
        }
        if (this._closed) { throw new Error('This desktop session cache has been closed.'); }
        const cached = this._entries.get(key);
        if (cached != null) {
            if (!isCaptureClosed(cached.capture)) {
                cached.inUse++;
                this._touch(cached);
                return cached;
            }
            await this._evict(key, cached);
        }

        let pending = this._pending.get(key);
        if (pending == null) {
            pending = this._launch(key, options || {});
            this._pending.set(key, pending);
            pending.then(() => this._pending.delete(key), () => this._pending.delete(key));
        }
        const entry = await pending;
        if (this._closed) {
            await releaseSession(entry.session);
            throw new Error('This desktop session cache has been closed.');
        }
        if (this._entries.get(key) == null) { this._entries.set(key, entry); }
        entry.inUse++;
        this._touch(entry);
        return entry;
    }

    /** Stop using a cached entry without closing it: its idle window starts now. */
    finish(entry) {
        if ((entry == null) || (entry.inUse <= 0)) { return; }
        entry.inUse--;
        if (this._entries.get(entry.key) !== entry) { return; }
        this._touch(entry);
    }

    /** Push back an entry's idle deadline, e.g. during a long input sequence. */
    touch(entry) {
        if ((entry == null) || (this._entries.get(entry.key) !== entry)) { return; }
        this._touch(entry);
    }

    /**
    * Close and forget one key's session. Pass the entry the caller holds to
    * leave a replacement session alone. Idempotent.
    */
    release(key, entry) {
        const current = this._entries.get(key);
        if (current == null) { return Promise.resolve(); }
        if ((entry != null) && (current !== entry)) { return Promise.resolve(); }
        return this._evict(key, current);
    }

    /** Close every cached session and empty the cache. The cache stays closed. */
    closeAll() {
        this._closed = true;
        const entries = Array.from(this._entries.values());
        this._entries.clear();
        for (const entry of entries) {
            if (entry.timer != null) { clearTimeout(entry.timer); entry.timer = null; }
            this._unwatch(entry);
            entry.inUse = 0;
        }
        return Promise.all(entries.map((entry) => releaseSession(entry.session))).then(() => undefined);
    }

    async _launch(key, options) {
        const session = await this._client.launchDesktopSession(key, options);
        if ((session == null) || (typeof session.attach !== 'function')) {
            throw new TypeError('The desktop relay launch for ' + key + ' returned no session to attach to.');
        }
        let capture = null;
        try {
            capture = await startSessionCapture(session, this._createCapture);
        } catch (error) {
            await releaseSession(session);
            throw error;
        }
        const entry = { key, session, capture, inUse: 0, lastUsed: this._now(), timer: null, onClose: null };
        this._watch(entry);
        this._attachExitHook();
        return entry;
    }

    // A capture that closes (relay drop, consent revoke, idle timeout on the
    // server) must not stay in the cache: the next acquire has to renegotiate.
    _watch(entry) {
        if (typeof entry.capture.once !== 'function') { return; }
        entry.onClose = () => {
            if (this._entries.get(entry.key) === entry) { void this._evict(entry.key, entry); }
        };
        entry.capture.once('close', entry.onClose);
    }

    _unwatch(entry) {
        if (entry.onClose == null) { return; }
        if (typeof entry.capture.removeListener === 'function') {
            entry.capture.removeListener('close', entry.onClose);
        }
        entry.onClose = null;
    }

    _touch(entry) {
        entry.lastUsed = this._now();
        this._reschedule(entry);
    }

    // No idle timer while the entry is in use: an active call cannot have its
    // session closed underneath it. finish() starts the window.
    _reschedule(entry) {
        if (entry.timer != null) { clearTimeout(entry.timer); entry.timer = null; }
        if ((this._idleTimeout <= 0) || (entry.inUse > 0)) { return; }
        entry.timer = setTimeout(() => { this._onIdle(entry); }, this._idleTimeout);
        if (entry.timer.unref) { entry.timer.unref(); }
    }

    _onIdle(entry) {
        entry.timer = null;
        if (this._entries.get(entry.key) !== entry) { return; }
        if (entry.inUse > 0) { return; }
        if ((this._now() - entry.lastUsed) < this._idleTimeout) {
            this._reschedule(entry);
            return;
        }
        void this._evict(entry.key, entry);
    }

    _evict(key, entry) {
        const current = this._entries.get(key);
        if ((current == null) || ((entry != null) && (current !== entry))) { return Promise.resolve(); }
        this._entries.delete(key);
        if (current.timer != null) { clearTimeout(current.timer); current.timer = null; }
        this._unwatch(current);
        return releaseSession(current.session);
    }

    _attachExitHook() {
        if (this._exitAttached) { return; }
        const lifecycle = this._lifecycle;
        if ((lifecycle == null) || (typeof lifecycle.once !== 'function')) { return; }
        this._exitAttached = true;
        lifecycle.once('exit', this._exitHook);
    }
}

function createDesktopSessionCache(options) {
    return new DesktopSessionCache(options);
}

module.exports = {
    DesktopSessionCache: DesktopSessionCache,
    createDesktopSessionCache: createDesktopSessionCache,
    DEFAULT_IDLE_TIMEOUT: DEFAULT_IDLE_TIMEOUT
};
