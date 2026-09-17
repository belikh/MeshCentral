'use strict';

/**
 * Tests for the MeshCentral desktop frames tool (mesh_desktop_frames).
 *
 * Every test injects a fake client, a fake capture factory and a fake lifecycle
 * emitter: no sockets, no relay and no live server. The frame fixture is
 * synthetic and sanitised. The session cache is the real one, driven by the
 * fakes, so cache reuse, eviction and release are exercised end to end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createToolRegistry } = require('../mcp-tool-registry.js');
const { createMcpServer } = require('../mcp-server.js');
const { registerDesktopTools } = require('../mcp-desktop-tools.js');
const { createDesktopSessionCache } = require('../desktop-session-cache.js');
const { RelayError } = require('../meshcentral-client.js');
const { DesktopCaptureError } = require('../desktopcapture.js');

const NODE_ID = 'node//AbCdEf012345';
const RELAY_URL = 'wss://mesh.example.test/meshrelay.ashx?browser=1&p=2&nodeid=node%2F%2FAbCdEf012345&id=tunnel-sanitised&auth=test-cookie';
const TIMESTAMP = Date.parse('2026-09-17T12:34:56.789Z');

// Synthetic fixture: a header-only JPEG declaring 1920x1080. Nothing here comes
// from a real system.
const TINY_JPEG = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xFF, 0xD9
]);

function jpegFrame(overrides) {
    return Object.assign({
        type: 'frame',
        index: 1,
        timestamp: TIMESTAMP,
        imageType: 1,
        format: 'jpeg',
        mimeType: 'image/jpeg',
        data: TINY_JPEG,
        length: TINY_JPEG.length,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        screen: { width: 1920, height: 1080 }
    }, overrides || {});
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createFakes(state) {
    state = state || {};
    const launches = [];
    const sessions = [];
    const captures = [];

    const client = {
        async launchDesktopSession(nodeid, options) {
            launches.push({ nodeid, options });
            if (state.launchError != null) { throw state.launchError; }
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
    };

    const factory = (config) => {
        const capture = new EventEmitter();
        capture.config = config;
        capture.state = 'idle';
        capture.started = 0;
        capture.closed = 0;
        capture.waits = [];
        capture.latest = null;
        capture.start = async function () {
            this.started++;
            if (state.startError != null) { throw state.startError; }
            this.state = 'connected';
        };
        capture.waitForFrame = async function (options) {
            this.waits.push(options);
            if (state.frameError != null) { throw state.frameError; }
            if (state.hang === true) {
                const timeout = ((options != null) && (options.timeout != null)) ? options.timeout : 10;
                return new Promise((resolve, reject) => {
                    setTimeout(() => reject(new DesktopCaptureError('Timed out waiting for a desktop frame', 'E_TIMEOUT')), timeout);
                });
            }
            if ((options != null) && (options.latest === true) && (this.latest != null) && (state.freshFrames !== true)) { return this.latest; }
            const frame = (state.frame != null) ? state.frame : jpegFrame({ index: this.waits.length, timestamp: TIMESTAMP + ((this.waits.length - 1) * 1000) });
            this.latest = frame;
            return frame;
        };
        capture.close = async function () {
            this.closed++;
            this.state = 'closed';
            this.emit('close', null);
        };
        captures.push(capture);
        return capture;
    };

    return { client, factory, launches, sessions, captures };
}

function createHarness(state) {
    const fakes = createFakes(state);
    const records = [];
    const lifecycle = new EventEmitter();
    const cache = createDesktopSessionCache({
        client: fakes.client,
        createCapture: fakes.factory,
        idleTimeout: ((state != null) && (state.idleTimeout != null)) ? state.idleTimeout : 30000,
        lifecycle: lifecycle
    });
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, { client: fakes.client, createCapture: fakes.factory, cache: cache });
    return Object.assign(fakes, { registry, records, cache, lifecycle });
}

test('mesh_desktop_frames returns a bounded sequence with per-frame metadata', async () => {
    const { registry, records, launches, captures, cache } = createHarness({ freshFrames: true });

    const started = Date.now();
    const result = await registry.call('mesh_desktop_frames', {
        deviceid: NODE_ID,
        count: 3,
        interval: 20,
        timeout: 5000
    });
    const elapsed = Date.now() - started;

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 6);
    for (let index = 0; index < 3; index++) {
        const image = result.content[index * 2];
        const text = result.content[index * 2 + 1];
        assert.equal(image.type, 'image');
        assert.equal(image.mimeType, 'image/jpeg');
        assert.equal(image.data, TINY_JPEG.toString('base64'));
        assert.equal(text.type, 'text');
        assert.match(text.text, new RegExp('resolution 1920x1080, format image\\/jpeg, frame ' + (index + 1) + ', captured 2026-09-17T12:34:5' + (6 + index) + '\\.789Z'));
    }
    assert.ok(elapsed >= 40, 'expected at least two intervals to elapse, saw ' + elapsed + 'ms');

    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0], { nodeid: NODE_ID, options: {} });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].started, 1);
    assert.equal(captures[0].waits.length, 3);
    for (const wait of captures[0].waits) {
        assert.equal(wait.latest, true);
        assert.equal(typeof wait.timeout, 'number');
    }
    assert.equal(cache.size, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_frames');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
    assert.equal(records[0].reason, null);
});

test('mesh_desktop_frames leaves the session cached for a later poll', async () => {
    const { registry, launches, sessions, captures, cache } = createHarness({ freshFrames: true });

    const sequence = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, count: 2, interval: 1 });
    assert.equal(sequence.isError, undefined);
    assert.equal(sessions[0].released, 0);
    assert.equal(cache.size, 1);

    const poll = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });
    assert.equal(poll.isError, undefined);
    assert.equal(launches.length, 1);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].waits.length, 3);
});

test('mesh_desktop_frames stops at the total timeout and returns the frames captured so far', async () => {
    const { registry, captures, cache } = createHarness({ freshFrames: true });

    const result = await registry.call('mesh_desktop_frames', {
        deviceid: NODE_ID,
        count: 10,
        interval: 100,
        timeout: 120
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 4);
    assert.equal(captures[0].waits.length, 2);
    assert.equal(cache.size, 1);
});

test('poll returns the latest frame and reuses one session across repeated polls', async () => {
    const { registry, records, launches, captures, sessions, cache } = createHarness();

    const first = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });
    const second = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });
    const third = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });

    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);
    assert.equal(third.isError, undefined);
    assert.equal(first.content.length, 2);
    assert.equal(first.content[0].type, 'image');
    assert.equal(first.content[0].mimeType, 'image/jpeg');
    assert.equal(first.content[0].data, TINY_JPEG.toString('base64'));
    assert.match(first.content[1].text, /resolution 1920x1080, format image\/jpeg, frame 1, captured 2026-09-17T12:34:56\.789Z/);
    assert.deepEqual(second.content, first.content);
    assert.deepEqual(third.content, first.content);

    assert.equal(launches.length, 1);
    assert.equal(captures.length, 1);
    assert.equal(sessions[0].released, 0);
    assert.equal(captures[0].waits.length, 3);
    assert.equal(cache.size, 1);
    assert.deepEqual(records.map((record) => record.outcome), ['ok', 'ok', 'ok']);
    assert.deepEqual(records.map((record) => record.target), [NODE_ID, NODE_ID, NODE_ID]);
});

test('poll passes image type, quality and scale into a freshly negotiated session', async () => {
    const { registry, launches, captures } = createHarness({ frame: jpegFrame({ format: 'png', mimeType: 'image/png', imageType: 2 }) });

    const result = await registry.call('mesh_desktop_frames', {
        deviceid: NODE_ID,
        mode: 'poll',
        imageType: 'png',
        quality: 80,
        scale: 256
    });

    assert.deepEqual(launches[0].options, { imageType: 2, compression: 80, scaling: 256 });
    assert.deepEqual(captures[0].config, { url: RELAY_URL, imageType: 2, compression: 80, scaling: 256 });
    assert.equal(result.content[0].mimeType, 'image/png');
    assert.match(result.content[1].text, /format image\/png/);
});

test('a failed poll releases the session, evicts the entry and the next poll renegotiates', async () => {
    const state = {
        frameError: new DesktopCaptureError('The desktop relay connection closed unexpectedly', 'E_CLOSED', { serverMessage: 'Consent declined by user' })
    };
    const { registry, records, launches, sessions, captures, cache } = createHarness(state);

    const failed = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });

    assert.deepEqual(failed, { content: [{ type: 'text', text: 'Consent declined by user' }], isError: true });
    assert.equal(cache.size, 0);
    assert.equal(sessions[0].released, 1);
    assert.equal(captures[0].closed, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].reason, 'Consent declined by user');

    state.frameError = null;
    const retried = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });

    assert.equal(retried.isError, undefined);
    assert.equal(launches.length, 2);
    assert.equal(sessions.length, 2);
    assert.equal(cache.size, 1);
});

test('a capture that fails to start after the relay opened releases the session', async () => {
    const { registry, records, launches, sessions, captures, cache } = createHarness({
        startError: new DesktopCaptureError('The desktop relay session is closed', 'E_CLOSED', { serverMessage: 'Device is offline' })
    });

    const result = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Device is offline' }], isError: true });
    assert.equal(launches.length, 1);
    assert.equal(sessions[0].released, 1);
    assert.equal(captures[0].closed, 1);
    assert.equal(cache.size, 0);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, NODE_ID);
});

test('a sequence that never receives a frame times out, evicts and reports', async () => {
    const { registry, records, sessions, captures, cache } = createHarness({ hang: true });

    const result = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, timeout: 30 });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Timed out waiting for a desktop frame/);
    assert.equal(cache.size, 0);
    assert.equal(sessions[0].released, 1);
    assert.equal(captures[0].closed, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, NODE_ID);
});

test('a refused relay launch is surfaced verbatim and leaves no entry', async () => {
    const message = 'Unable to launch a desktop relay session for ' + NODE_ID + ': Access denied: missing device group rights';
    const { registry, records, sessions, cache } = createHarness({
        launchError: new RelayError(message, 'ELAUCHFAILED', 'Access denied: missing device group rights')
    });

    const result = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });

    assert.deepEqual(result, { content: [{ type: 'text', text: message }], isError: true });
    assert.equal(sessions.length, 0);
    assert.equal(cache.size, 0);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].reason, message);
});

test('the cached session closes after idle and a later poll opens a new one', async () => {
    const { registry, launches, sessions, cache } = createHarness({ idleTimeout: 30 });

    await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });
    assert.equal(cache.size, 1);

    await delay(60);
    assert.equal(cache.size, 0);
    assert.equal(sessions[0].released, 1);

    const result = await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });
    assert.equal(result.isError, undefined);
    assert.equal(launches.length, 2);
    assert.equal(sessions.length, 2);
});

test('cached frame sessions close when the process exits', async () => {
    const { registry, sessions, captures, cache, lifecycle } = createHarness();

    await registry.call('mesh_desktop_frames', { deviceid: NODE_ID, mode: 'poll' });
    assert.equal(cache.size, 1);

    lifecycle.emit('exit', 0);
    await delay(0);

    assert.equal(cache.size, 0);
    assert.equal(sessions[0].released, 1);
    assert.equal(captures[0].closed, 1);
});

test('mesh_desktop_frames validates its arguments through the registry', async () => {
    const { registry, records, launches, captures } = createHarness();

    const cases = [
        {},
        { deviceid: NODE_ID, mode: 'burst' },
        { deviceid: NODE_ID, count: 0 },
        { deviceid: NODE_ID, count: 11 },
        { deviceid: NODE_ID, interval: 0 },
        { deviceid: NODE_ID, interval: 60001 },
        { deviceid: NODE_ID, timeout: 0 },
        { deviceid: NODE_ID, imageType: 'bmp' },
        { deviceid: NODE_ID, scale: 0 }
    ];
    for (const args of cases) {
        const result = await registry.call('mesh_desktop_frames', args);
        assert.equal(result.isError, true, 'expected a denial for ' + JSON.stringify(args));
    }

    assert.equal(launches.length, 0);
    assert.equal(captures.length, 0);
    assert.deepEqual(records.map((record) => record.outcome), cases.map(() => 'denied'));
});

test('the frames declaration has no credential arguments and a device id target', () => {
    const { registry } = createHarness();

    const tool = registry.get('mesh_desktop_frames');
    assert.deepEqual(Object.keys(tool.inputSchema), ['deviceid', 'mode', 'count', 'interval', 'timeout', 'imageType', 'quality', 'scale']);
    for (const property of Object.keys(tool.inputSchema)) {
        assert.doesNotMatch(property, /pass|token|key|secret|credential/i);
    }
    assert.equal(tool.target({ deviceid: NODE_ID }), NODE_ID);
});

test('an MCP client can call mesh_desktop_frames over a transport', async (t) => {
    const fakes = createFakes();
    const lifecycle = new EventEmitter();
    const cache = createDesktopSessionCache({
        client: fakes.client,
        createCapture: fakes.factory,
        lifecycle: lifecycle
    });
    const records = [];
    const server = createMcpServer({
        client: fakes.client,
        audit: { record: (record) => records.push(record) },
        registerTools: (registry, context) => registerDesktopTools(registry, { client: context.client, createCapture: fakes.factory, cache: cache })
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'mesh_desktop_frames'));

    const result = await client.callTool({ name: 'mesh_desktop_frames', arguments: { deviceid: NODE_ID, mode: 'poll' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/jpeg');
    assert.equal(result.content[0].data, TINY_JPEG.toString('base64'));
    assert.match(result.content[1].text, /resolution 1920x1080, format image\/jpeg/);

    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_frames');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
});
