'use strict';

/**
 * Tests for the /mcp Streamable HTTP endpoint.
 *
 * The handler is driven over a real ephemeral HTTP listener with the MCP
 * SDK's Streamable HTTP client transport. The authenticator and the
 * MeshCentral client are stubs: no MeshCentral server, no login tokens.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { createMcpHttpHandler } = require('../mcp-http.js');

const GOOD_TOKEN = 'Bearer good-token';
const ACCOUNT = { userid: 'user//alpha', username: 'Alpha' };

function createFakeClient() {
    return {
        connected: 0,
        closed: 0,
        async connect() { this.connected++; },
        async request(action, params) { return { action: action, result: 'ok', nodes: {} }; },
        async close() { this.closed++; }
    };
}

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => { handler(req, res); });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server: server, url: 'http://127.0.0.1:' + server.address().port + '/mcp' });
        });
    });
}

function createHandler(overrides) {
    const records = [];
    const clients = [];
    const handler = createMcpHttpHandler(Object.assign({
        authenticate: async (req) => ((req.headers.authorization === GOOD_TOKEN) ? ACCOUNT : null),
        createClient: async () => {
            const client = createFakeClient();
            clients.push(client);
            return client;
        },
        audit: { record: (entry) => records.push(entry) },
        idleTimeout: 5000
    }, overrides || {}));
    return { handler: handler, records: records, clients: clients };
}

function connectClient(url, token) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: token || GOOD_TOKEN } }
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    return { client: client, transport: transport };
}

test('requests without a valid credential receive 401', async (t) => {
    const { handler } = createHandler();
    const started = await startServer(handler);
    t.after(() => new Promise((resolve) => started.server.close(resolve)));

    for (const token of [null, 'Bearer wrong-token', 'Basic abc']) {
        const response = await fetch(started.url, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, (token != null) ? { Authorization: token } : {}),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
        });
        assert.equal(response.status, 401, 'token ' + String(token));
    }
});

test('an authenticated MCP client lists and calls tools over HTTP', async (t) => {
    const { handler, records, clients } = createHandler();
    const started = await startServer(handler);
    t.after(() => new Promise((resolve) => started.server.close(resolve)));

    const { client, transport } = connectClient(started.url);
    t.after(async () => { await transport.close(); });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('mesh_list_devices'));
    assert.ok(names.includes('mesh_desktop_snapshot'));

    const result = await client.callTool({ name: 'mesh_list_devices', arguments: {} });
    assert.equal(result.isError, undefined);

    assert.equal(clients.length, 1);
    assert.equal(clients[0].connected, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_list_devices');
    assert.equal(records[0].account, ACCOUNT.userid);
});

test('requests with an unknown session receive 404', async (t) => {
    const { handler } = createHandler();
    const started = await startServer(handler);
    t.after(() => new Promise((resolve) => started.server.close(resolve)));

    const response = await fetch(started.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: GOOD_TOKEN,
            'mcp-session-id': '00000000-0000-0000-0000-000000000000'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(response.status, 404);
});

test('a GET without a session receives 400', async (t) => {
    const { handler } = createHandler();
    const started = await startServer(handler);
    t.after(() => new Promise((resolve) => started.server.close(resolve)));

    const response = await fetch(started.url, { method: 'GET', headers: { Authorization: GOOD_TOKEN } });
    assert.equal(response.status, 400);
});

test('an idle session is closed and its client released', async (t) => {
    const { handler, clients } = createHandler({ idleTimeout: 80 });
    const started = await startServer(handler);
    t.after(() => new Promise((resolve) => started.server.close(resolve)));

    const { client, transport } = connectClient(started.url);
    t.after(async () => { await transport.close(); });
    await client.connect(transport);
    assert.equal(clients.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(client.listTools());
    assert.equal(clients[0].closed, 1);
});

test('the handler requires its collaborators', () => {
    assert.throws(() => createMcpHttpHandler({}), /authenticate/);
    assert.throws(() => createMcpHttpHandler({ authenticate: async () => null }), /createClient/);
});
