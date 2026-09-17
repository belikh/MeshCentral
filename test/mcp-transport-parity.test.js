'use strict';

/**
 * Cross-transport parity tests for the MeshCentral MCP bridge.
 *
 * The stdio bridge and the Streamable HTTP endpoint must expose the same tool
 * surface and shape the same data identically. Both real transports are driven
 * here: the stdio entry point is spawned against a fake control websocket
 * server, and the /mcp handler runs on an ephemeral listener with a fake
 * MeshCentral client fed the same fixtures. The captured tools/list
 * declarations and one representative tools/call result are compared field for
 * field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { createMcpHttpHandler } = require('../mcp-http.js');

const SERVER_PATH = path.join(__dirname, '..', 'mcp-server.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const handshake = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'control-handshake.json'), 'utf8'));
const nodesFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'nodes.json'), 'utf8'));

const GOOD_TOKEN = 'Bearer parity-token';
const ACCOUNT = { userid: 'user//alpha', username: 'Alpha' };
const REPRESENTATIVE_TOOL = 'mesh_list_devices';

/** Start a fake MeshCentral control server that answers with the shared fixtures. */
async function startFakeControlServer(t) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    t.after(() => new Promise((done) => {
        for (const socket of wss.clients) { socket.terminate(); }
        wss.close(done);
    }));
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify(handshake.serverinfo));
        ws.send(JSON.stringify(handshake.userinfo));
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.action === 'serverversion') {
                ws.send(JSON.stringify(Object.assign({}, handshake.serverversion, { responseid: message.responseid })));
            } else if (message.action === 'nodes') {
                ws.send(JSON.stringify(Object.assign({}, nodesFixture, { responseid: message.responseid })));
            }
        });
    });
    return wss;
}

/** The same fixture data the fake control server serves, behind a fake client. */
function createFakeMeshCentralClient() {
    return {
        connected: false,
        async connect() { this.connected = true; },
        async request(action) {
            if (action === 'nodes') { return nodesFixture; }
            throw new Error('Unexpected action "' + action + '".');
        },
        async close() { this.connected = false; }
    };
}

/** Start the real /mcp handler on an ephemeral listener. */
async function startHttpServer(t) {
    const clients = [];
    const handler = createMcpHttpHandler({
        authenticate: async (req) => ((req.headers.authorization === GOOD_TOKEN) ? ACCOUNT : null),
        createClient: async () => {
            const client = createFakeMeshCentralClient();
            clients.push(client);
            return client;
        },
        audit: { record: () => {} },
        idleTimeout: 5000
    });
    const server = http.createServer((req, res) => { handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { url: 'http://127.0.0.1:' + server.address().port + '/mcp', clients: clients };
}

/** Capture tools/list and the representative call from the spawned stdio bridge. */
async function captureStdioSurface(t) {
    const wss = await startFakeControlServer(t);
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_PATH, '--url', 'ws://127.0.0.1:' + wss.address().port, '--connecttimeout', '3000', '--commandtimeout', '3000'],
        stderr: 'pipe'
    });
    const client = new Client({ name: 'parity-stdio', version: '0.0.0' });
    t.after(async () => { await client.close(); });
    await client.connect(transport);
    return {
        tools: (await client.listTools()).tools,
        call: await client.callTool({ name: REPRESENTATIVE_TOOL, arguments: {} })
    };
}

/** Capture tools/list and the representative call from the /mcp endpoint. */
async function captureHttpSurface(t) {
    const started = await startHttpServer(t);
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
        requestInit: { headers: { Authorization: GOOD_TOKEN } }
    });
    const client = new Client({ name: 'parity-http', version: '0.0.0' });
    t.after(async () => { await client.close(); });
    await client.connect(transport);
    return {
        tools: (await client.listTools()).tools,
        call: await client.callTool({ name: REPRESENTATIVE_TOOL, arguments: {} })
    };
}

/** Sort tool declarations by name so the comparison ignores list ordering. */
function byName(tools) {
    return tools.slice().sort((left, right) => left.name.localeCompare(right.name));
}

test('the stdio bridge and the HTTP endpoint expose the same tools and call result', { timeout: 30000 }, async (t) => {
    const stdio = await captureStdioSurface(t);
    const http = await captureHttpSurface(t);

    assert.ok(stdio.tools.length > 1, 'the stdio surface is non-trivial');
    assert.ok(stdio.tools.some((tool) => tool.name === REPRESENTATIVE_TOOL));
    assert.ok(http.tools.some((tool) => tool.name === REPRESENTATIVE_TOOL));

    assert.deepEqual(byName(http.tools).map((tool) => tool.name), byName(stdio.tools).map((tool) => tool.name));
    assert.deepEqual(byName(http.tools), byName(stdio.tools));

    assert.equal(stdio.call.isError, undefined);
    assert.equal(http.call.isError, undefined);
    assert.match(stdio.call.content[0].text, /host-alpha/);
    assert.match(stdio.call.content[0].text, /host-beta/);
    assert.deepEqual(http.call, stdio.call);
});
