'use strict';

/**
 * Tests for the transport-neutral bridge factory.
 *
 * The factory is the single place that builds the tool registry and registers
 * the command and desktop tools. Every test injects a fake MeshCentral client
 * and a fake capture factory: no sockets, no relay and no live server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createBridgeServer } = require('../mcp-bridge.js');
const { MeshCentralClient, ConfigurationError } = require('../meshcentral-client.js');

const NODE_ID = 'node//AbCdEf012345';

// Synthetic fixture: a header-only JPEG. Nothing comes from a real system.
const TINY_JPEG = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xFF, 0xD9
]);

function createFakes() {
    const launches = [];
    const session = {
        captureConfig: { url: 'wss://mesh.example.test/meshrelay.ashx?browser=1&p=2&id=tunnel-sanitised' },
        attach(capture) { return capture; },
        async release() { }
    };
    const client = {
        requests: [],
        serverInfo: null,
        userInfo: null,
        async request(action, params) {
            this.requests.push({ action, params });
            return { action, result: 'ok', nodes: {} };
        },
        async launchDesktopSession(nodeid, options) {
            launches.push({ nodeid, options });
            session.captureConfig = Object.assign({}, session.captureConfig, options);
            return session;
        }
    };
    const factory = (config) => ({
        config,
        async start() { },
        async waitForFrame() {
            return {
                type: 'frame',
                index: 1,
                timestamp: Date.parse('2026-09-17T12:34:56.789Z'),
                imageType: 1,
                format: 'jpeg',
                mimeType: 'image/jpeg',
                data: TINY_JPEG,
                length: TINY_JPEG.length,
                x: 0, y: 0, width: 1920, height: 1080,
                screen: { width: 1920, height: 1080 }
            };
        },
        async close() { }
    });
    return { client, factory, session, launches };
}

test('the factory requires a client', () => {
    assert.throws(() => createBridgeServer({}), ConfigurationError);
});

test('connect requires a transport', () => {
    const fakes = createFakes();
    const server = createBridgeServer({ client: fakes.client, audit: { record: () => { } } });
    assert.throws(() => server.connect(), ConfigurationError);
});

test('the factory registers the command tools and the desktop tools in one place', () => {
    const fakes = createFakes();
    const server = createBridgeServer({ client: fakes.client, audit: { record: () => { } } });
    const names = server.registry.list().map((tool) => tool.name);
    assert.ok(names.includes('mesh_list_devices'), 'command tool registered');
    assert.ok(names.includes('mesh_desktop_snapshot'));
    assert.ok(names.includes('mesh_desktop_frames'));
    assert.ok(names.includes('mesh_desktop_input'));
    assert.ok(names.includes('mesh_desktop_status'));
    assert.ok(names.length > 40, 'the catalogue tools are all registered');
    assert.equal(server.client, fakes.client);
});

test('injected capture defaults and factory reach the desktop tools', async () => {
    const fakes = createFakes();
    const records = [];
    const server = createBridgeServer({
        client: fakes.client,
        audit: { record: (record) => records.push(record) },
        createCapture: fakes.factory,
        defaults: { imageType: 'png', quality: 12, scale: 800 }
    });

    const result = await server.registry.call('mesh_desktop_snapshot', { deviceid: NODE_ID });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/jpeg');

    assert.equal(fakes.launches.length, 1);
    assert.equal(fakes.launches[0].nodeid, NODE_ID);
    assert.deepEqual(fakes.launches[0].options, { imageType: 2, compression: 12, scaling: 800 });

    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_snapshot');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
});

test('the factory built server serves tools over an injected transport', async (t) => {
    const fakes = createFakes();
    const records = [];
    const server = createBridgeServer({
        client: fakes.client,
        audit: { record: (record) => records.push(record) },
        createCapture: fakes.factory
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('mesh_list_devices'));
    assert.ok(names.includes('mesh_desktop_snapshot'));

    const result = await client.callTool({ name: 'mesh_list_devices', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_list_devices');
});

test('a MeshCentralClient instance satisfies the factory contract', () => {
    const client = new MeshCentralClient({ url: 'wss://mesh.example.test' });
    const server = createBridgeServer({ client: client, audit: { record: () => { } } });
    assert.equal(server.client, client);
    assert.ok(server.registry.list().length > 40);
});
