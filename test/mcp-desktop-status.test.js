'use strict';

/**
 * Tests for the MeshCentral desktop status tool (mesh_desktop_status).
 *
 * Every test injects a fake client and, where sessions matter, a fake session
 * cache: no sockets, no relay and no live server. The node fixture is
 * synthetic and sanitised. The central assertion is that the tool never calls
 * launchDesktopSession: status is a report, not a session.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createToolRegistry } = require('../mcp-tool-registry.js');
const { registerDesktopTools } = require('../mcp-desktop-tools.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const NODE_ID = 'node//AbCdEf012345';
const MESH_ID = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const FULL_ADMIN = 0xFFFFFFFF;
const REMOTECONTROL = 8;
const UNKNOWN = null;

// The device capability bit that says the agent supports a desktop.
const CAPS_DESKTOP = 1;

function createFakeClient(state) {
    state = state || {};
    const requests = [];
    const launches = [];
    const client = {
        requests,
        launches,
        serverInfo: (state.serverInfo !== undefined) ? state.serverInfo : { domain: '' },
        userInfo: (state.userInfo !== undefined) ? state.userInfo : { _id: 'user//admin', siteadmin: FULL_ADMIN, links: {} },
        async request(action, params) {
            requests.push({ action, params });
            if (state.requestError != null) { throw state.requestError; }
            if (state.nodesError != null) { throw state.nodesError; }
            return { action: 'nodes', result: 'ok', nodes: state.nodes || {} };
        },
        async launchDesktopSession(nodeid, options) {
            launches.push({ nodeid, options });
            throw new Error('mesh_desktop_status must not launch a desktop session');
        }
    };
    return client;
}

function nodesFixture(overrides) {
    return {
        [MESH_ID]: [Object.assign({
            _id: NODE_ID,
            name: 'host-alpha',
            conn: 1,
            pwr: 1,
            agent: { id: 4, ver: '0.0.0', caps: CAPS_DESKTOP }
        }, overrides || {})]
    };
}

function createHarness(state, registration) {
    state = state || {};
    const client = createFakeClient(state);
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, Object.assign({ client: client, createCapture: () => { throw new Error('no capture expected'); } }, registration || {}));
    return { client, registry, records };
}

function statusOf(result) {
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    return JSON.parse(result.content[0].text);
}

test('an online capable device with the desktop right reports ready and launches nothing', async () => {
    const { client, registry, records } = createHarness({ nodes: nodesFixture() });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'ready');
    assert.equal(status.reasons.length, 0);
    assert.deepEqual(status.device, { id: NODE_ID, name: 'host-alpha', meshid: MESH_ID });
    assert.equal(status.online, true);
    assert.equal(status.agent.desktop, true);
    assert.equal(status.agent.caps, CAPS_DESKTOP);
    assert.equal(status.account.desktopRight, true);
    assert.equal(status.session.cached, false);
    assert.equal(status.session.encoding, null);
    assert.equal(status.session.ageMs, null);

    assert.equal(client.launches.length, 0);
    assert.deepEqual(client.requests, [{ action: 'nodes', params: {} }]);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_status');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
});

test('an offline device is reported blocked with the offline reason', async () => {
    const { registry } = createHarness({ nodes: nodesFixture({ conn: 0, pwr: 0 }) });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'blocked');
    assert.equal(status.online, false);
    assert.deepEqual(status.reasons, ['offline']);
});

test('a device whose agent reports no desktop support is reported blocked', async () => {
    const { registry } = createHarness({ nodes: nodesFixture({ agent: { id: 4, ver: '0.0.0', caps: 0 } }) });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'blocked');
    assert.equal(status.agent.desktop, false);
    assert.deepEqual(status.reasons, ['desktop-unsupported']);
});

test('a device with no capability data reports the capability as unknown', async () => {
    const node = nodesFixture()[MESH_ID][0];
    delete node.agent;
    const { registry } = createHarness({ nodes: { [MESH_ID]: [node] } });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'ready');
    assert.equal(status.agent.desktop, UNKNOWN);
    assert.equal(status.agent.caps, UNKNOWN);
    assert.deepEqual(status.reasons, []);
});

test('an account without the desktop right is reported blocked and ready is withheld', async () => {
    const { client, registry, records } = createHarness({
        nodes: nodesFixture(),
        userInfo: { _id: 'user//viewer', siteadmin: 0, links: { [MESH_ID]: { rights: 1 } } }
    });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'blocked');
    assert.equal(status.account.desktopRight, false);
    assert.deepEqual(status.reasons, ['missing-desktop-right']);
    assert.equal(client.launches.length, 0);
    assert.equal(records[0].outcome, 'ok');
    assert.equal(records[0].target, NODE_ID);
});

test('a per-device group remote control right counts as the desktop right', async () => {
    const { registry } = createHarness({
        nodes: nodesFixture(),
        userInfo: { _id: 'user//operator', siteadmin: 0, links: { [MESH_ID]: { rights: REMOTECONTROL } } }
    });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'ready');
    assert.equal(status.account.desktopRight, true);
});

test('a per-device remote control link counts as the desktop right', async () => {
    const { registry } = createHarness({
        nodes: nodesFixture(),
        userInfo: { _id: 'user//operator', siteadmin: 0, links: { [NODE_ID]: { rights: REMOTECONTROL } } }
    });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'ready');
    assert.equal(status.account.desktopRight, true);
});

test('a full site administrator without links holds the desktop right', async () => {
    const { registry } = createHarness({
        nodes: nodesFixture(),
        userInfo: { _id: 'user//admin', siteadmin: FULL_ADMIN, links: {} }
    });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'ready');
    assert.equal(status.account.desktopRight, true);
});

test('a missing desktop right is indeterminate when no handshake userinfo is available', async () => {
    const { registry } = createHarness({ nodes: nodesFixture(), userInfo: null });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'unknown');
    assert.equal(status.account.desktopRight, UNKNOWN);
    assert.deepEqual(status.reasons, ['rights-unknown']);
});

test('offline, unsupported and missing right stack their reasons in order', async () => {
    const { registry } = createHarness({
        nodes: nodesFixture({ conn: 0, pwr: 0, agent: { id: 4, ver: '0.0.0', caps: 0 } }),
        userInfo: { _id: 'user//viewer', siteadmin: 0, links: {} }
    });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.status, 'blocked');
    assert.deepEqual(status.reasons, ['offline', 'desktop-unsupported', 'missing-desktop-right']);
});

test('an unknown device id is a tool error, not a status report', async () => {
    const { client, registry, records } = createHarness({ nodes: nodesFixture() });

    const result = await registry.call('mesh_desktop_status', { deviceid: 'node//NoSuchDevice' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid device id/);
    assert.equal(client.launches.length, 0);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, 'node//NoSuchDevice');
});

test('a server refusal of the nodes request surfaces verbatim', async () => {
    const { registry, records } = createHarness({ nodesError: new Error('Access denied: missing device group rights') });

    const result = await registry.call('mesh_desktop_status', { deviceid: NODE_ID });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied: missing device group rights' }], isError: true });
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].target, NODE_ID);
});

test('an uncached device reports no session and opens none', async () => {
    const cache = {
        peek: () => null,
        acquire: () => { throw new Error('mesh_desktop_status must not acquire a session'); },
        finish: () => { },
        release: () => { }
    };
    const { client, registry } = createHarness({ nodes: nodesFixture() }, { cache: cache });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.session.cached, false);
    assert.equal(status.session.ageMs, null);
    assert.equal(status.session.encoding, null);
    assert.equal(client.launches.length, 0);
});

test('a cached session reports its age and configured encoding', async () => {
    const capture = new EventEmitter();
    capture.encoding = { imageType: 2, compression: 80, scaling: 512, frameRate: 100 };
    const cache = { peek: (key) => ((key === NODE_ID) ? { capture, lastUsed: 1000 } : null) };
    const { registry } = createHarness({ nodes: nodesFixture() }, { cache: cache, now: () => 6000 });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.session.cached, true);
    assert.equal(status.session.ageMs, 5000);
    assert.deepEqual(status.session.encoding, { imageType: 'png', quality: 80, scale: 512 });
    assert.equal(status.status, 'ready');
});

test('a cached session reports the capture defaults as its encoding when unconfigured', async () => {
    const capture = new EventEmitter();
    capture.config = { url: 'wss://mesh.example.test/meshrelay.ashx' };
    // A real DesktopCapture resolves its encoding from the config defaults.
    capture.encoding = { imageType: 1, compression: 50, scaling: 1024, frameRate: 100 };
    const cache = { peek: () => ({ capture, lastUsed: 1000 }) };
    const { registry } = createHarness({ nodes: nodesFixture() }, { cache: cache, now: () => 1000 });

    const status = statusOf(await registry.call('mesh_desktop_status', { deviceid: NODE_ID }));

    assert.equal(status.session.cached, true);
    assert.equal(status.session.ageMs, 1);
    assert.deepEqual(status.session.encoding, { imageType: 'jpeg', quality: 50, scale: 1024 });
});

test('the declaration takes only a device id, has a device id target and no credentials', () => {
    const { registry } = createHarness();

    const tool = registry.get('mesh_desktop_status');
    assert.deepEqual(Object.keys(tool.inputSchema), ['deviceid']);
    for (const property of Object.keys(tool.inputSchema)) {
        assert.doesNotMatch(property, /pass|token|key|secret|credential/i);
    }
    assert.equal(tool.target({ deviceid: NODE_ID }), NODE_ID);
});

test('the status tool validates its arguments through the registry', async () => {
    const { registry, records } = createHarness();

    const missing = await registry.call('mesh_desktop_status', {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /deviceid/);
    assert.equal(records.map((record) => record.outcome).join(','), 'denied');
});

test('an MCP client can call mesh_desktop_status over a transport and launch nothing', async (t) => {
    const client = createFakeClient({ nodes: nodesFixture() });
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record) });
    registerDesktopTools(registry, { client: client });
    const mcp = new McpServer({ name: 'meshcentral-mcp', version: '0.0.0' });
    for (const tool of registry.list()) {
        mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args) => registry.call(tool.name, args));
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await mcpClient.close(); await mcp.close(); await clientTransport.close(); });

    await Promise.all([mcp.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const listed = await mcpClient.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'mesh_desktop_status'));

    const result = await mcpClient.callTool({ name: 'mesh_desktop_status', arguments: { deviceid: NODE_ID } });
    assert.equal(result.isError, undefined);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.status, 'ready');
    assert.equal(status.device.id, NODE_ID);

    assert.equal(client.launches.length, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_desktop_status');
    assert.equal(records[0].target, NODE_ID);
    assert.equal(records[0].outcome, 'ok');
});
