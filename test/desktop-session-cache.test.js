'use strict';

/**
 * Tests for the short-lived desktop session cache.
 *
 * A fake client, fake sessions and fake captures stand in for the relay: no
 * sockets, no live server. The fake lifecycle emitter lets the tests drive the
 * process exit hook without touching the real process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createDesktopSessionCache, DesktopSessionCache, DEFAULT_IDLE_TIMEOUT } = require('../desktop-session-cache.js');
const { DesktopCaptureError } = require('../desktopcapture.js');
const { RelayError } = require('../meshcentral-client.js');

const RELAY_URL = 'wss://mesh.example.test/meshrelay.ashx?browser=1&p=2&nodeid=node%2F%2FAbCdEf012345&id=tunnel-sanitised&auth=test-cookie';

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// One consistent fake environment: launches return sessions, sessions attach
// captures, captures can fail to start or close on demand.
function createFakes(state) {
    state = state || {};
    const launches = [];
    const sessions = [];
    const captures = [];

    function makeSession(options) {
        const session = {
            captureConfig: Object.assign({ url: RELAY_URL }, state.captureConfig, options),
            released: 0,
            attached: null,
            attach(capture) {
                if (state.attachError != null) { throw state.attachError; }
                this.attached = capture;
                return capture;
            },
            async release() {
                this.released++;
                if (this.attached != null) { await this.attached.close(); }
            }
        };
        sessions.push(session);
        return session;
    }

    const client = {
        async launchDesktopSession(key, options) {
            launches.push({ key, options });
            if (state.launchError != null) { throw state.launchError; }
            return makeSession(options);
        }
    };

    function createCapture(config) {
        if (state.createCaptureError != null) { throw state.createCaptureError; }
        const capture = new EventEmitter();
        capture.config = config;
        capture.state = 'idle';
        capture.started = 0;
        capture.closed = 0;
        capture.start = async function () {
            this.started++;
            if (state.startError != null) { throw state.startError; }
            this.state = 'connected';
        };
        capture.waitForFrame = async function () { return null; };
        capture.close = async function () {
            this.closed++;
            this.state = 'closed';
            this.emit('close', null);
        };
        captures.push(capture);
        return capture;
    }

    return { client, createCapture, launches, sessions, captures };
}

function createCache(fakes, options) {
    return createDesktopSessionCache(Object.assign({
        client: fakes.client,
        createCapture: fakes.createCapture,
        lifecycle: null
    }, options || {}));
}

test('acquire launches once per key and reuses the cached session', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    const first = await cache.acquire('node//AbCdEf012345', { imageType: 2 });
    cache.finish(first);
    const second = await cache.acquire('node//AbCdEf012345');

    assert.equal(fakes.launches.length, 1);
    assert.deepEqual(fakes.launches[0], { key: 'node//AbCdEf012345', options: { imageType: 2 } });
    assert.equal(second, first);
    assert.equal(cache.size, 1);
    assert.equal(cache.peek('node//AbCdEf012345'), first);
    assert.equal(fakes.captures.length, 1);
    assert.equal(fakes.captures[0].started, 1);
    assert.equal(fakes.sessions[0].released, 0);
});

test('peek reports the cached entry without launching anything', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    assert.equal(cache.peek('node//AbCdEf012345'), null);
    assert.equal(fakes.launches.length, 0);

    const entry = await cache.acquire('node//AbCdEf012345');
    assert.equal(cache.peek('node//AbCdEf012345'), entry);
    assert.equal(fakes.launches.length, 1);
});

test('concurrent acquires for one key share a single launch', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    const [first, second] = await Promise.all([
        cache.acquire('node//AbCdEf012345'),
        cache.acquire('node//AbCdEf012345')
    ]);

    assert.equal(fakes.launches.length, 1);
    assert.equal(fakes.captures.length, 1);
    assert.equal(first, second);
    assert.equal(first.inUse, 2);

    cache.finish(first);
    cache.finish(second);
    assert.equal(cache.size, 1);
    assert.equal(fakes.sessions[0].released, 0);
});

test('a capture that fails to start is released and never cached', async () => {
    const error = new DesktopCaptureError('The desktop relay session is closed', 'E_CLOSED', { serverMessage: 'Device is offline' });
    const fakes = createFakes({ startError: error });
    const cache = createCache(fakes);

    await assert.rejects(cache.acquire('node//AbCdEf012345'), (rejected) => rejected === error);

    assert.equal(cache.size, 0);
    assert.equal(cache.peek('node//AbCdEf012345'), null);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(fakes.captures[0].closed, 1);
});

test('a capture factory that throws still releases the opened session', async () => {
    const error = new Error('The viewer could not be created.');
    const fakes = createFakes({ createCaptureError: error });
    const cache = createCache(fakes);

    await assert.rejects(cache.acquire('node//AbCdEf012345'), (rejected) => rejected === error);

    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(fakes.captures.length, 0);
});

test('a refused launch leaves no entry and a later acquire retries', async () => {
    const state = { launchError: new RelayError('Access denied: missing device group rights', 'ELAUCHFAILED', 'Access denied') };
    const fakes = createFakes(state);
    const cache = createCache(fakes);

    await assert.rejects(cache.acquire('node//AbCdEf012345'), /Access denied/);

    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions.length, 0);

    state.launchError = null;
    const entry = await cache.acquire('node//AbCdEf012345');
    assert.equal(fakes.launches.length, 2);
    assert.equal(cache.peek('node//AbCdEf012345'), entry);
});

test('a capture that closes on its own is evicted and the next acquire relaunches', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    const entry = await cache.acquire('node//AbCdEf012345');
    assert.equal(cache.size, 1);

    entry.capture.emit('close', null);

    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);

    const replacement = await cache.acquire('node//AbCdEf012345');
    assert.notEqual(replacement, entry);
    assert.equal(fakes.launches.length, 2);
    assert.equal(fakes.captures.length, 2);
});

test('a stale closed capture is replaced on the next acquire', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    const entry = await cache.acquire('node//AbCdEf012345');
    entry.capture.state = 'closed';

    const replacement = await cache.acquire('node//AbCdEf012345');
    assert.notEqual(replacement, entry);
    assert.equal(fakes.launches.length, 2);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(cache.size, 1);
});

test('release closes the cached session and removes the entry', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    const entry = await cache.acquire('node//AbCdEf012345');
    cache.finish(entry);
    await cache.release('node//AbCdEf012345', entry);

    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(fakes.captures[0].closed, 1);
});

test('release ignores an entry that is no longer current', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    const entry = await cache.acquire('node//AbCdEf012345');
    cache.finish(entry);
    await cache.release('node//AbCdEf012345', { key: 'node//AbCdEf012345' });

    assert.equal(cache.size, 1);
    assert.equal(fakes.sessions[0].released, 0);
});

test('an idle session is closed after the idle timeout', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes, { idleTimeout: 30 });

    const entry = await cache.acquire('node//AbCdEf012345');
    cache.finish(entry);
    await delay(20);
    assert.equal(cache.size, 1);

    await delay(30);
    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(fakes.captures[0].closed, 1);
});

test('an in-use session is protected from idle eviction until finished', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes, { idleTimeout: 30 });

    const entry = await cache.acquire('node//AbCdEf012345');
    await delay(50);
    assert.equal(cache.size, 1);
    assert.equal(fakes.sessions[0].released, 0);

    cache.finish(entry);
    await delay(50);
    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
});

test('touch extends the idle deadline', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes, { idleTimeout: 40 });

    const entry = await cache.acquire('node//AbCdEf012345');
    cache.finish(entry);
    await delay(25);
    cache.touch(entry);
    await delay(25);
    assert.equal(cache.size, 1);

    await delay(30);
    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
});

test('closeAll closes every cached session and empties the cache', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    const first = await cache.acquire('node//AbCdEf000001');
    const second = await cache.acquire('node//AbCdEf000002');
    cache.finish(first);
    cache.finish(second);

    await cache.closeAll();

    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(fakes.sessions[1].released, 1);
    assert.equal(fakes.captures[0].closed, 1);
    assert.equal(fakes.captures[1].closed, 1);
});

test('closeAll during an in-flight launch releases the session and refuses new work', async () => {
    const fakes = createFakes();
    let resumeLaunch = null;
    const gate = new Promise((resolve) => { resumeLaunch = resolve; });
    const client = {
        async launchDesktopSession(key, options) {
            await gate;
            return fakes.client.launchDesktopSession(key, options);
        }
    };
    const cache = createDesktopSessionCache({ client: client, createCapture: fakes.createCapture, lifecycle: null });

    const acquisition = cache.acquire('node//AbCdEf012345');
    const closed = cache.closeAll();
    resumeLaunch();
    await closed;

    await assert.rejects(acquisition, /closed/i);
    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(fakes.captures[0].closed, 1);
    await assert.rejects(cache.acquire('node//AbCdEf012345'), /closed/i);
});

test('process exit closes every cached session', async () => {
    const fakes = createFakes();
    const lifecycle = new EventEmitter();
    const cache = createCache(fakes, { lifecycle: lifecycle });

    const first = await cache.acquire('node//AbCdEf000001');
    const second = await cache.acquire('node//AbCdEf000002');
    cache.finish(first);
    cache.finish(second);

    lifecycle.emit('exit', 0);
    await delay(0);

    assert.equal(cache.size, 0);
    assert.equal(fakes.sessions[0].released, 1);
    assert.equal(fakes.sessions[1].released, 1);
    assert.equal(fakes.captures[0].closed, 1);
    assert.equal(fakes.captures[1].closed, 1);
});

test('the cache exposes its defaults and validates its keys', async () => {
    const fakes = createFakes();
    const cache = createCache(fakes);

    assert.equal(cache.idleTimeout, DEFAULT_IDLE_TIMEOUT);
    assert.equal(typeof createDesktopSessionCache, 'function');
    assert.equal(typeof DesktopSessionCache, 'function');
    await assert.rejects(cache.acquire(''), /key/i);
    assert.throws(() => createDesktopSessionCache({}), /client/i);
});
