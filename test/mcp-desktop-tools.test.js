'use strict';

/**
 * Tests for the MeshCentral desktop tools (mesh_desktop_snapshot).
 *
 * Every test injects a fake client and a fake capture factory: no sockets, no
 * relay and no live server. The frame fixture is synthetic and sanitised.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createToolRegistry, imageResult } = require('../mcp-tool-registry.js');
const { createMcpServer } = require('../mcp-server.js');
const { registerDesktopTools } = require('../mcp-desktop-tools.js');
const { AuthError, RelayError } = require('../meshcentral-client.js');
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
        index: 3,
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

function createFakes(state) {
    state = state || {};
    const launches = [];
    const captures = [];
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
    const client = {
        async launchDesktopSession(nodeid, options) {
            launches.push({ nodeid, options });
            if (state.launchError != null) { throw state.launchError; }
            session.captureConfig = Object.assign({ url: RELAY_URL }, state.captureConfig, options);
            return session;
        }
    };
    const factory = (config) => {
        const capture = {
            config,
            started: 0,
            closed: 0,
            async start() {
                this.started++;
                if (state.startError != null) { throw state.startError; }
            },
            async waitForFrame(options) {
                this.waitOptions = options;
                if (state.frameError != null) { throw state.frameError; }
                return (state.frame != null) ? state.frame : jpegFrame();
            },
            async close() { this.closed++; }
        };
        captures.push(capture);
        return capture;
    };
    return { client, factory, session, launches, captures };
}

function createHarness(state) {
    const fakes = createFakes(state);
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, { client: fakes.client, createCapture: fakes.factory });
    return Object.assign(fakes, { registry, records });
}

test('mesh_desktop_snapshot returns an image block and a metadata text block', async () => {
    const { registry, records, launches, captures, session } = createHarness();

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    assert.deepEqual(result.content[0], {
        type: 'image',
        data: TINY_JPEG.toString('base64'),
        mimeType: 'image/jpeg'
    });
    assert.equal(result.content[1].type, 'text');
    assert.equal(result.content[1].text, 'resolution 1920x1080, format image/jpeg, frame 3, captured 2026-09-17T12:34:56.789Z');

    assert.deepEqual(launches, [{ nodeid: NODE_ID, options: {} }]);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].started, 1);
    assert.deepEqual(captures[0].waitOptions, { latest: true });
    assert.deepEqual(captures[0].config, { url: RELAY_URL });
    assert.equal(session.released, 1);
    assert.equal(captures[0].closed, 1);

    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_snapshot');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
    assert.equal(records[0].reason, null);
});

test('mesh_desktop_snapshot leaves image type, quality and scale to the capture module by default', async () => {
    const { registry, launches, captures } = createHarness();

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.deepEqual(launches[0].options, {});
    assert.deepEqual(captures[0].config, { url: RELAY_URL });
    assert.equal(result.content[0].mimeType, 'image/jpeg');
});

test('mesh_desktop_snapshot maps image type, quality and scale into the capture config', async () => {
    const { registry, launches, captures } = createHarness({ frame: jpegFrame({ format: 'png', mimeType: 'image/png', imageType: 2 }) });

    const result = await registry.call('mesh_desktop_snapshot', {
        deviceid: NODE_ID,
        imageType: 'png',
        quality: 80,
        scale: 256
    });

    assert.deepEqual(launches[0].options, { imageType: 2, compression: 80, scaling: 256 });
    assert.deepEqual(captures[0].config, { url: RELAY_URL, imageType: 2, compression: 80, scaling: 256 });
    assert.equal(result.content[0].mimeType, 'image/png');
    assert.match(result.content[1].text, /format image\/png/);
});

test('configured desktop defaults are applied to a launched session', async () => {
    const state = { frame: jpegFrame({ format: 'png', mimeType: 'image/png', imageType: 2 }) };
    const fakes = createFakes(state);
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, {
        client: fakes.client,
        createCapture: fakes.factory,
        defaults: { imageType: 'png', quality: 70, scale: 800 }
    });

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.deepEqual(fakes.launches[0].options, { imageType: 2, compression: 70, scaling: 800 });
    assert.deepEqual(fakes.captures[0].config, { url: RELAY_URL, imageType: 2, compression: 70, scaling: 800 });
    assert.equal(result.content[0].mimeType, 'image/png');
});

test('explicit tool arguments override the configured desktop defaults', async () => {
    const state = { frame: jpegFrame() };
    const fakes = createFakes(state);
    const registry = createToolRegistry();
    registerDesktopTools(registry, {
        client: fakes.client,
        createCapture: fakes.factory,
        defaults: { imageType: 'png', quality: 70, scale: 800 }
    });

    await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID, imageType: 'jpeg', quality: 90, scale: 320 });

    assert.deepEqual(fakes.launches[0].options, { imageType: 1, compression: 90, scaling: 320 });
});

test('mesh_desktop_snapshot surfaces a relay launch denial verbatim', async () => {
    const message = 'Unable to launch a desktop relay session for ' + NODE_ID + ': Access denied: missing device group rights';
    const { registry, records, captures } = createHarness({
        launchError: new RelayError(message, 'ELAUCHFAILED', 'Access denied: missing device group rights')
    });

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.deepEqual(result, { content: [{ type: 'text', text: message }], isError: true });
    assert.equal(captures.length, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].reason, message);
});

test('mesh_desktop_snapshot surfaces an authentication failure verbatim', async () => {
    const { registry, records, captures } = createHarness({
        launchError: new AuthError('Invalid login.', 'noauth', 'nokey')
    });

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Invalid login.' }], isError: true });
    assert.equal(captures.length, 0);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Invalid login.');
});

test('mesh_desktop_snapshot surfaces a declined consent message and releases the session', async () => {
    const { registry, records, captures, session } = createHarness({
        frameError: new DesktopCaptureError('The desktop relay connection closed unexpectedly', 'E_CLOSED', { serverMessage: 'Consent declined by user' })
    });

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Consent declined by user' }], isError: true });
    assert.equal(session.released, 1);
    assert.equal(captures[0].closed, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Consent declined by user');
});

test('mesh_desktop_snapshot surfaces a capture failure verbatim and releases the session', async () => {
    const { registry, captures, session } = createHarness({
        startError: new DesktopCaptureError('The desktop relay session is closed', 'E_CLOSED', { serverMessage: 'Device is offline' })
    });

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Device is offline' }], isError: true });
    assert.equal(session.released, 1);
    assert.equal(captures[0].closed, 1);
});

test('mesh_desktop_snapshot keeps an error message that has no server text', async () => {
    const { registry, session } = createHarness({
        frameError: new DesktopCaptureError('Timed out waiting for a desktop frame', 'E_TIMEOUT')
    });

    const result = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Timed out waiting for a desktop frame' }], isError: true });
    assert.equal(session.released, 1);
});

test('mesh_desktop_snapshot validates its arguments through the registry', async () => {
    const { registry, records, captures } = createHarness();

    const missing = await registry.call('mesh_desktop_snapshot', {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /deviceid/);

    const badType = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID, imageType: 'bmp' });
    assert.equal(badType.isError, true);

    const badScale = await registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID, scale: 0 });
    assert.equal(badScale.isError, true);

    assert.equal(captures.length, 0);
    assert.deepEqual(records.map((record) => record.outcome), ['denied', 'denied', 'denied']);
});

test('the declaration has no credential arguments and a device id target', () => {
    const { registry } = createHarness();

    const tool = registry.get('mesh_desktop_snapshot');
    assert.deepEqual(Object.keys(tool.inputSchema), ['deviceid', 'imageType', 'quality', 'scale']);
    for (const property of Object.keys(tool.inputSchema)) {
        assert.doesNotMatch(property, /pass|token|key|secret|credential/i);
    }
    assert.equal(tool.target({ deviceid: NODE_ID }), NODE_ID);
});

test('imageResult builds an image block and an optional text block', () => {
    assert.deepEqual(imageResult(TINY_JPEG, 'image/jpeg'), {
        content: [{ type: 'image', data: TINY_JPEG.toString('base64'), mimeType: 'image/jpeg' }]
    });
    assert.deepEqual(imageResult(TINY_JPEG, 'image/jpeg', 'meta'), {
        content: [
            { type: 'image', data: TINY_JPEG.toString('base64'), mimeType: 'image/jpeg' },
            { type: 'text', text: 'meta' }
        ]
    });
    assert.throws(() => imageResult(null, 'image/jpeg'), /image/i);
});

test('an MCP client can call mesh_desktop_snapshot over a transport', async (t) => {
    const fakes = createFakes();
    const records = [];
    const server = createMcpServer({
        client: fakes.client,
        audit: { record: (record) => records.push(record) },
        registerTools: (registry, context) => registerDesktopTools(registry, { client: context.client, createCapture: fakes.factory })
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('mesh_desktop_snapshot'));
    assert.ok(toolNames.includes('mesh_list_devices'));

    const result = await client.callTool({ name: 'mesh_desktop_snapshot', arguments: { deviceid: NODE_ID } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/jpeg');
    assert.equal(result.content[0].data, TINY_JPEG.toString('base64'));
    assert.match(result.content[1].text, /resolution 1920x1080, format image\/jpeg/);

    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_snapshot');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
});
