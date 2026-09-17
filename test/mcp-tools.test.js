'use strict';

/**
 * Tests for the MeshCentral tools built on the MCP tool registry.
 *
 * Every test injects a fake MeshCentral client into the server factory: no
 * live server, no real tokens, node ids or domains. Fixtures are sanitised.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createMcpServer } = require('../mcp-server.js');
const { TimeoutError } = require('../meshcentral-client.js');

const nodesFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nodes.json'), 'utf8'));

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const MESH_BRAVO = 'mesh//MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy';

function createFakeClient(state) {
    state = state || {};
    const requests = [];
    return {
        requests,
        async request(action, params) {
            requests.push({ action, params });
            if (state.error != null) { throw state.error; }
            if (state.response !== undefined) { return state.response; }
            return { action, result: 'ok', nodes: {} };
        }
    };
}

function createServer(state) {
    const records = [];
    const client = createFakeClient(state);
    const server = createMcpServer({ client, audit: { record: (record) => records.push(record) } });
    return { client, server, records };
}

test('mesh_list_devices requests nodes and shapes devices as text', async () => {
    const { client, server } = createServer({ response: nodesFixture });

    const result = await server.registry.call('mesh_list_devices', {});

    assert.deepEqual(client.requests, [{ action: 'nodes', params: {} }]);
    assert.deepEqual(result, {
        content: [{
            type: 'text',
            text: [
                'id, name, group, connected, power',
                '"node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "host-alpha", "' + MESH_ALPHA + '", 1, 1',
                '"node//BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "host-beta", "' + MESH_BRAVO + '", 0, 0'
            ].join('\n')
        }]
    });
});

test('mesh_list_devices forwards a meshid to the nodes action', async () => {
    const { client, server } = createServer({ response: nodesFixture });

    await server.registry.call('mesh_list_devices', { meshid: MESH_ALPHA });

    assert.deepEqual(client.requests, [{ action: 'nodes', params: { meshid: MESH_ALPHA } }]);
});

test('mesh_list_devices filters case-insensitively by name and id', async () => {
    const { server } = createServer({ response: nodesFixture });

    const byName = await server.registry.call('mesh_list_devices', { filter: 'ALPHA' });
    assert.match(byName.content[0].text, /host-alpha/);
    assert.doesNotMatch(byName.content[0].text, /host-beta/);

    const byId = await server.registry.call('mesh_list_devices', { filter: 'bbbb' });
    assert.match(byId.content[0].text, /host-beta/);
    assert.doesNotMatch(byId.content[0].text, /host-alpha/);
});

test('mesh_list_devices reports an empty device list in plain words', async () => {
    const { server } = createServer({ response: { action: 'nodes', result: 'ok', nodes: {} } });
    const result = await server.registry.call('mesh_list_devices', {});
    assert.deepEqual(result, { content: [{ type: 'text', text: 'No devices found.' }] });
});

test('a server error result is surfaced verbatim', async () => {
    const { server, records } = createServer({ response: { action: 'nodes', result: 'Access denied: missing device group rights' } });

    const result = await server.registry.call('mesh_list_devices', {});

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'Access denied: missing device group rights' }],
        isError: true
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Access denied: missing device group rights');
});

test('a transport failure is surfaced verbatim', async () => {
    const error = new TimeoutError('Command "nodes" timed out after 30ms.', 'ETIMEDOUT', 'nodes', 30);
    const { server, records } = createServer({ error });

    const result = await server.registry.call('mesh_list_devices', {});

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'Command "nodes" timed out after 30ms.' }],
        isError: true
    });
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Command "nodes" timed out after 30ms.');
});

// Account creation and editing arguments follow the word "pass" without
// carrying a bridge credential: they set or reset the password of the account
// being administered. The bridge's own login material still never travels
// through tool arguments, and every other declaration stays covered by the
// rule.
const ACCOUNT_PASSWORD_ARGUMENTS = new Set([
    'mesh_add_user.pass',
    'mesh_add_user.randompass',
    'mesh_add_user.resetpass',
    'mesh_edit_user.resetpass'
]);

test('tool declarations take no credential arguments', async () => {
    const { server } = createServer({});

    const tools = server.registry.list();
    const listDevices = tools.find((tool) => tool.name === 'mesh_list_devices');
    assert.ok(listDevices != null);

    for (const tool of tools) {
        const properties = Object.keys(tool.inputSchema);
        for (const property of properties) {
            if (ACCOUNT_PASSWORD_ARGUMENTS.has(tool.name + '.' + property)) { continue; }
            assert.doesNotMatch(property, /pass|token|key|secret|credential/i, tool.name + '.' + property);
        }
    }
});

test('an MCP client can list tools and call mesh_list_devices over a transport', async (t) => {
    const { server } = createServer({ response: nodesFixture });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'mesh_list_devices'));
    const listDevices = listed.tools.find((tool) => tool.name === 'mesh_list_devices');
    assert.equal(listDevices.description, server.registry.get('mesh_list_devices').description);
    assert.equal(listDevices.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(listDevices.inputSchema.properties).sort(), ['count', 'filter', 'group', 'meshid']);

    const result = await client.callTool({ name: 'mesh_list_devices', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /host-alpha/);
    assert.match(result.content[0].text, /host-beta/);
});
