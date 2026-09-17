'use strict';

/**
 * Tests for mesh_desktop_input.
 *
 * Every test injects a fake client, fake relay session and fake capture: no
 * sockets, no relay and no live server. The image fixtures are synthetic.
 *
 * Look-act-look demo loop
 * -----------------------
 * The last test in this file is the documented demo loop. It drives one fake
 * device through the three tool calls an agent uses:
 *
 *   1. mesh_desktop_snapshot  - see the screen, decide a target pixel
 *   2. mesh_desktop_input     - click that pixel, given in frame coordinates
 *   3. mesh_desktop_snapshot  - see the screen change
 *
 * The fake device records the input commands it receives and swaps its screen
 * when the click lands, so the test proves the second snapshot changed because
 * of the input, with no live agent. A session cache (a sibling ticket) lets
 * step 2 reuse step 1's relay session; without one, each call negotiates its
 * own session and releases it again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createToolRegistry } = require('../mcp-tool-registry.js');
const { registerDesktopTools, desktopInput } = require('../mcp-desktop-tools.js');
const { AuthError, RelayError } = require('../meshcentral-client.js');
const {
    DesktopCaptureError,
    encodeMouseMove,
    encodeMouseButton,
    encodeMouseScroll,
    encodeKey,
    encodeKeyUnicode
} = require('../desktopcapture.js');

const NODE_ID = 'node//AbCdEf012345';
const RELAY_URL = 'wss://mesh.example.test/meshrelay.ashx?browser=1&p=2&nodeid=node%2F%2FAbCdEf012345&id=tunnel-sanitised&auth=test-cookie';
const TIMESTAMP = Date.parse('2026-09-17T12:34:56.789Z');
const FRAME_1024 = { x: 0, y: 0, width: 1024, height: 768, screen: { width: 1920, height: 1080 } };

function createFakes(state) {
    state = state || {};
    const launches = [];
    const captures = [];
    const sessions = [];
    const client = {
        async launchDesktopSession(nodeid, options) {
            launches.push({ nodeid, options });
            if (state.launchError != null) { throw state.launchError; }
            const session = {
                captureConfig: { url: RELAY_URL },
                released: 0,
                attached: null,
                attach(capture) { this.attached = capture; return capture; },
                async release() {
                    this.released++;
                    if (this.attached != null) { await this.attached.close(); }
                }
            };
            session.captureConfig = Object.assign({ url: RELAY_URL }, state.captureConfig, options);
            sessions.push(session);
            return session;
        }
    };
    const factory = (config) => {
        const capture = {
            config,
            started: 0,
            closed: 0,
            sent: [],
            waitOptions: [],
            async start() {
                this.started++;
                if (state.startError != null) { throw state.startError; }
            },
            async waitForFrame(options) {
                this.waitOptions.push(options);
                if (state.frameError != null) { throw state.frameError; }
                return (state.waitFrame !== undefined) ? state.waitFrame : null;
            },
            getLatestFrame() {
                return (state.latestFrame !== undefined) ? state.latestFrame : null;
            },
            sendCommand(buffer) {
                this.sent.push(buffer);
                if (state.sendError != null) { throw state.sendError; }
                return (state.sendResult !== undefined) ? state.sendResult : true;
            },
            async close() { this.closed++; }
        };
        captures.push(capture);
        return capture;
    };
    return { client, factory, sessions, launches, captures };
}

function createHarness(state, registration) {
    const fakes = createFakes(state);
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, Object.assign({ client: fakes.client, createCapture: fakes.factory }, registration || {}));
    return Object.assign(fakes, { registry, records });
}

test('mesh_desktop_input applies a mixed action list in order', async () => {
    const { registry, records, launches, captures, sessions } = createHarness();

    const result = await registry.call('mesh_desktop_input', {
        deviceid: NODE_ID,
        actions: [
            { type: 'move', x: 100, y: 200 },
            { type: 'click', x: 100, y: 200 },
            { type: 'scroll', x: 100, y: 200, delta: 120 },
            { type: 'key', key: 'Enter' },
            { type: 'text', text: 'Hi' }
        ]
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'Applied 5 actions to ' + NODE_ID + '.' }] });
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].sent, [
        encodeMouseMove(100, 200),
        encodeMouseButton('left', true, 100, 200),
        encodeMouseButton('left', false, 100, 200),
        encodeMouseScroll(100, 200, 120),
        encodeKey('down', 'Enter'),
        encodeKey('up', 'Enter'),
        encodeKeyUnicode('down', 72),
        encodeKeyUnicode('up', 72),
        encodeKeyUnicode('down', 105),
        encodeKeyUnicode('up', 105)
    ]);

    assert.deepEqual(launches, [{ nodeid: NODE_ID, options: {} }]);
    assert.equal(captures[0].started, 1);
    assert.equal(captures[0].closed, 1);
    assert.equal(sessions[0].released, 1);

    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_input');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
    assert.equal(records[0].reason, null);
});

test('mesh_desktop_input separates press and release with the step delay', async () => {
    const fakes = createFakes();
    const capture = fakes.factory({ url: RELAY_URL });
    const waits = [];

    const result = await desktopInput(fakes.client, {
        deviceid: NODE_ID,
        actions: [{ type: 'text', text: 'ab' }]
    }, fakes.factory, { capture, sleep: (milliseconds) => { waits.push(milliseconds); return Promise.resolve(); } });

    assert.equal(result.isError, undefined);
    assert.deepEqual(waits, [5, 5, 5]);
    assert.deepEqual(capture.sent, [
        encodeKeyUnicode('down', 97),
        encodeKeyUnicode('up', 97),
        encodeKeyUnicode('down', 98),
        encodeKeyUnicode('up', 98)
    ]);
    assert.equal(fakes.launches.length, 0);
    assert.equal(capture.closed, 0);
});

test('mesh_desktop_input reuses a supplied capture without a relay session', async () => {
    const fakes = createFakes();
    const capture = fakes.factory({ url: RELAY_URL });
    await capture.start();

    const result = await desktopInput(fakes.client, {
        deviceid: NODE_ID,
        actions: [{ type: 'key', key: 'Escape' }]
    }, fakes.factory, { capture, sleep: () => Promise.resolve() });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Applied 1 action to ' + NODE_ID + '.' }] });
    assert.equal(fakes.launches.length, 0);
    assert.equal(capture.closed, 0);
    assert.deepEqual(capture.sent, [encodeKey('down', 'Escape'), encodeKey('up', 'Escape')]);
});

test('the registered tool reuses a cached capture through acquireCapture', async () => {
    const fakes = createFakes();
    const capture = fakes.factory({ url: RELAY_URL });
    await capture.start();
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, {
        client: fakes.client,
        createCapture: fakes.factory,
        acquireCapture: (deviceid) => (deviceid === NODE_ID) ? capture : null
    });

    const result = await registry.call('mesh_desktop_input', { deviceid: NODE_ID, actions: [{ type: 'move', x: 1, y: 2 }] });

    assert.equal(result.isError, undefined);
    assert.equal(fakes.launches.length, 0);
    assert.equal(capture.closed, 0);
    assert.deepEqual(capture.sent, [encodeMouseMove(1, 2)]);
});

test('mesh_desktop_input scales coordinates from the frame screen metadata', async () => {
    const fakes = createFakes({ latestFrame: FRAME_1024 });
    const capture = fakes.factory({ url: RELAY_URL });

    const result = await desktopInput(fakes.client, {
        deviceid: NODE_ID,
        actions: [{ type: 'click', x: 512, y: 384 }]
    }, fakes.factory, { capture, sleep: () => Promise.resolve() });

    assert.equal(result.isError, undefined);
    assert.deepEqual(capture.sent, [
        encodeMouseButton('left', true, 960, 540),
        encodeMouseButton('left', false, 960, 540)
    ]);
});

test('mesh_desktop_input reads the first frame when it opens the session', async () => {
    const { registry, captures } = createHarness({ waitFrame: FRAME_1024 });

    const result = await registry.call('mesh_desktop_input', {
        deviceid: NODE_ID,
        actions: [{ type: 'move', x: 512, y: 384 }]
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(captures[0].waitOptions, [{ latest: true, timeout: 5000 }]);
    assert.deepEqual(captures[0].sent, [encodeMouseMove(960, 540)]);
});

test('mesh_desktop_input does not wait for a frame when only text acts', async () => {
    const { registry, captures } = createHarness();

    const result = await registry.call('mesh_desktop_input', {
        deviceid: NODE_ID,
        actions: [{ type: 'text', text: 'ok' }]
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(captures[0].waitOptions, []);
    assert.equal(captures[0].sent.length, 4);
});

test('mesh_desktop_input falls back to unscreened coordinates when no frame arrives', async () => {
    const { registry, captures } = createHarness({
        frameError: new DesktopCaptureError('Timed out waiting for a desktop frame', 'E_TIMEOUT')
    });

    const result = await registry.call('mesh_desktop_input', {
        deviceid: NODE_ID,
        actions: [{ type: 'move', x: 10, y: 20 }]
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(captures[0].sent, [encodeMouseMove(10, 20)]);
});

test('mesh_desktop_input surfaces a relay launch denial verbatim', async () => {
    const message = 'Unable to launch a desktop relay session for ' + NODE_ID + ': Access denied: missing device group rights';
    const { registry, records, captures } = createHarness({
        launchError: new RelayError(message, 'ELAUCHFAILED', 'Access denied: missing device group rights')
    });

    const result = await registry.call('mesh_desktop_input', { deviceid: NODE_ID, actions: [{ type: 'move', x: 0, y: 0 }] });

    assert.deepEqual(result, { content: [{ type: 'text', text: message }], isError: true });
    assert.equal(captures.length, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].reason, message);
});

test('mesh_desktop_input surfaces an authentication failure verbatim', async () => {
    const { registry, records } = createHarness({ launchError: new AuthError('Invalid login.', 'noauth', 'nokey') });

    const result = await registry.call('mesh_desktop_input', { deviceid: NODE_ID, actions: [{ type: 'text', text: 'x' }] });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Invalid login.' }], isError: true });
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Invalid login.');
});

test('mesh_desktop_input surfaces a declined consent message and releases the session', async () => {
    const { registry, records, captures, sessions } = createHarness({
        startError: new DesktopCaptureError('The desktop relay session is closed', 'E_CLOSED', { serverMessage: 'Consent declined by user' })
    });

    const result = await registry.call('mesh_desktop_input', { deviceid: NODE_ID, actions: [{ type: 'move', x: 0, y: 0 }] });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Consent declined by user' }], isError: true });
    assert.equal(sessions[0].released, 1);
    assert.equal(captures[0].closed, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Consent declined by user');
});

test('mesh_desktop_input surfaces a closed session when sending', async () => {
    const { registry, records, captures, sessions } = createHarness({ sendResult: false });

    const result = await registry.call('mesh_desktop_input', { deviceid: NODE_ID, actions: [{ type: 'move', x: 0, y: 0 }] });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'The desktop relay session is closed' }], isError: true });
    assert.equal(captures[0].sent.length, 1);
    assert.equal(sessions[0].released, 1);
    assert.equal(captures[0].closed, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'The desktop relay session is closed');
});

test('mesh_desktop_input validates its arguments through the registry', async () => {
    const { registry, records, captures } = createHarness();

    const cases = [
        [{ deviceid: NODE_ID }, /actions/],
        [{ deviceid: NODE_ID, actions: [] }, /actions/],
        [{ deviceid: NODE_ID, actions: [{ type: 'move', x: 0, y: 0 }].concat(new Array(200).fill({ type: 'move', x: 0, y: 0 })) }, /actions/],
        [{ deviceid: NODE_ID, actions: [{ type: 'bogus' }] }, /Invalid arguments/],
        [{ deviceid: NODE_ID, actions: [{ type: 'move', x: -1, y: 0 }] }, /Invalid arguments/],
        [{ deviceid: NODE_ID, actions: [{ type: 'click', x: 0, y: 0, button: 'thumb' }] }, /Invalid arguments/],
        [{ deviceid: NODE_ID, actions: [{ type: 'scroll', x: 0, y: 0, delta: 40000 }] }, /Invalid arguments/],
        [{ deviceid: NODE_ID, actions: [{ type: 'key', key: 'Bogus' }] }, /Invalid arguments/],
        [{ deviceid: NODE_ID, actions: [{ type: 'text', text: '' }] }, /Invalid arguments/],
        [{ actions: [{ type: 'move', x: 0, y: 0 }] }, /deviceid/]
    ];
    for (const [args, pattern] of cases) {
        const result = await registry.call('mesh_desktop_input', args);
        assert.equal(result.isError, true, JSON.stringify(args));
        assert.match(result.content[0].text, pattern, JSON.stringify(args));
    }

    assert.equal(captures.length, 0);
    assert.deepEqual(records.map((record) => record.outcome), cases.map(() => 'denied'));
});

test('the mesh_desktop_input declaration has no credential arguments and a device id target', () => {
    const { registry } = createHarness();

    const tool = registry.get('mesh_desktop_input');
    assert.deepEqual(Object.keys(tool.inputSchema), ['deviceid', 'actions']);
    for (const property of Object.keys(tool.inputSchema)) {
        assert.doesNotMatch(property, /pass|token|key|secret|credential/i);
    }
    assert.equal(tool.target({ deviceid: NODE_ID }), NODE_ID);
});

// The documented demo loop: snapshot, act, snapshot. The fake device swaps its
// frame when the click lands, so the second snapshot can only show the new
// screen if the input was applied at the coordinates the first frame implied.
test('look-act-look: snapshot, input, snapshot shows the screen change', async () => {
    const before = Buffer.from([0xFF, 0xD8, 0x01, 0xFF, 0xD9]);
    const after = Buffer.from([0xFF, 0xD8, 0x02, 0xFF, 0xD9]);
    const device = {
        frame: Object.assign({
            index: 1,
            timestamp: TIMESTAMP,
            imageType: 1,
            format: 'jpeg',
            mimeType: 'image/jpeg',
            data: before,
            length: before.length
        }, FRAME_1024),
        clicks: []
    };
    const launches = [];
    const client = {
        async launchDesktopSession(nodeid, options) {
            launches.push({ nodeid, options });
            return {
                captureConfig: { url: RELAY_URL },
                released: 0,
                attached: null,
                attach(capture) { this.attached = capture; return capture; },
                async release() { this.released++; }
            };
        }
    };
    const createCapture = (config) => ({
        config,
        sent: [],
        async start() { },
        async waitForFrame(options) { return device.frame; },
        getLatestFrame() { return null; },
        sendCommand(buffer) {
            this.sent.push(buffer);
            device.clicks.push(buffer);
            device.frame = Object.assign({}, device.frame, { index: device.frame.index + 1, data: after, length: after.length });
            return true;
        },
        async close() { }
    });
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, { client, createCapture });

    // 1. See the screen.
    const first = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });
    assert.equal(first.isError, undefined);
    assert.equal(first.content[0].data, before.toString('base64'));

    // 2. Act on the screen the first snapshot showed: click frame pixel 64,64,
    //    which is screen pixel 120,90 on the 1920x1080 remote screen.
    const input = await registry.call('mesh_desktop_input', {
        deviceid: NODE_ID,
        actions: [{ type: 'click', x: 64, y: 64 }]
    });
    assert.equal(input.isError, undefined);
    assert.deepEqual(device.clicks, [
        encodeMouseButton('left', true, 120, 90),
        encodeMouseButton('left', false, 120, 90)
    ]);

    // 3. See the change.
    const second = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });
    assert.equal(second.isError, undefined);
    assert.equal(second.content[0].data, after.toString('base64'));

    assert.deepEqual(launches.map((launch) => launch.nodeid), [NODE_ID, NODE_ID, NODE_ID]);
    assert.deepEqual(records.map((record) => record.tool), ['mesh_desktop_snapshot', 'mesh_desktop_input', 'mesh_desktop_snapshot']);
    assert.deepEqual(records.map((record) => record.target), [NODE_ID, NODE_ID, NODE_ID]);
    assert.deepEqual(records.map((record) => record.outcome), ['ok', 'ok', 'ok']);
});
