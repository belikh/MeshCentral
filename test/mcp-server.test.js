'use strict';

/**
 * Tests for the MeshCentral MCP bridge entry point: configuration precedence,
 * the audit log, the server factory and a subprocess smoke test of the stdio
 * entry point. No live MeshCentral server is required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const { parseConfig, createAuditLog, createMcpServer, main } = require('../mcp-server.js');
const { ConfigurationError } = require('../meshcentral-client.js');
const packageJson = require('../package.json');

const SERVER_PATH = path.join(__dirname, '..', 'mcp-server.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const handshake = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'control-handshake.json'), 'utf8'));
const nodesFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'nodes.json'), 'utf8'));

function runChild(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER_PATH].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, timedOut });
        });
    });
}

function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function captureStream() {
    const lines = [];
    return {
        lines,
        write(chunk) { lines.push(String(chunk)); }
    };
}

test('requiring the entry point has no CLI side effects', () => {
    const result = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(SERVER_PATH) + ')'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
});

test('parseConfig takes flags over environment values', () => {
    const options = parseConfig([
        '--url', 'wss://flag.example',
        '--loginuser', 'flaguser',
        '--loginpass', 'flagpass',
        '--token', '123456',
        '--loginkeyfile', '/tmp/flag.key',
        '--logindomain', 'flagdomain',
        '--proxy', 'http://proxy.example:8080',
        '--commandtimeout', '1234',
        '--connecttimeout', '4321'
    ], {
        MESHCENTRAL_URL: 'wss://env.example',
        MESHCENTRAL_USER: 'envuser',
        MESHCENTRAL_PASSWORD: 'envpass',
        MESHCENTRAL_TOKEN: '999999',
        MESHCENTRAL_LOGINKEYFILE: '/tmp/env.key',
        MESHCENTRAL_DOMAIN: 'envdomain',
        MESHCENTRAL_PROXY: 'http://envproxy.example:8080',
        MESHCENTRAL_COMMAND_TIMEOUT: '5678',
        MESHCENTRAL_CONNECT_TIMEOUT: '8765'
    });

    assert.deepEqual(options, {
        help: false,
        version: false,
        config: {
            url: 'wss://flag.example',
            user: 'flaguser',
            password: 'flagpass',
            token: '123456',
            loginKeyFile: '/tmp/flag.key',
            domain: 'flagdomain',
            proxy: 'http://proxy.example:8080',
            commandTimeout: 1234,
            connectTimeout: 4321
        }
    });
});

test('parseConfig falls back to environment values and leaves the rest to client defaults', () => {
    const options = parseConfig([], {
        MESHCENTRAL_URL: 'wss://env.example',
        MESHCENTRAL_USER: 'envuser',
        MESHCENTRAL_PASSWORD: 'envpass',
        MESHCENTRAL_COMMAND_TIMEOUT: '2500'
    });

    assert.deepEqual(options, {
        help: false,
        version: false,
        config: {
            url: 'wss://env.example',
            user: 'envuser',
            password: 'envpass',
            commandTimeout: 2500
        }
    });
});

test('parseConfig reports help and version without building a client config', () => {
    const help = parseConfig(['--help'], { MESHCENTRAL_URL: 'wss://env.example' });
    assert.equal(help.help, true);
    assert.deepEqual(help.config, { url: 'wss://env.example' });

    const version = parseConfig(['--version'], {});
    assert.equal(version.version, true);
});

test('parseConfig rejects invalid timeouts with an actionable message', () => {
    for (const args of [['--commandtimeout', 'soon'], ['--connecttimeout', '0'], ['--commandtimeout', '-5']]) {
        assert.throws(() => parseConfig(args, {}), (err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.match(err.message, new RegExp(args[0]));
            assert.match(err.message, /milliseconds/);
            return true;
        });
    }
});

test('parseConfig rejects a password flag with no value instead of prompting', () => {
    assert.throws(() => parseConfig(['--loginpass'], {}), (err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /--loginpass/);
        assert.match(err.message, /does not prompt/);
        return true;
    });
});

test('createAuditLog writes one JSON record with the required fields', () => {
    const stream = captureStream();
    const log = createAuditLog({ stream, now: () => new Date('2026-09-17T00:00:00.000Z') });

    log.record({ tool: 'mesh_list_devices', target: 'all', outcome: 'ok', duration: 12, reason: null });

    assert.equal(stream.lines.length, 1);
    assert.equal(stream.lines[0].endsWith('\n'), true);
    assert.deepEqual(JSON.parse(stream.lines[0]), {
        timestamp: '2026-09-17T00:00:00.000Z',
        tool: 'mesh_list_devices',
        target: 'all',
        outcome: 'ok',
        durationMs: 12,
        reason: null
    });
});

test('audit records never include credentials', () => {
    const stream = captureStream();
    const log = createAuditLog({ stream });

    log.record({
        tool: 'mesh_list_devices',
        target: 'wss://mc.example.test/control.ashx?key=deadbeef',
        outcome: 'error',
        duration: 3,
        reason: 'Unable to connect to wss://mc.example.test/control.ashx?key=deadbeef&auth=c2VjcmV0'
    });

    const output = stream.lines.join('');
    assert.doesNotMatch(output, /deadbeef/);
    assert.doesNotMatch(output, /c2VjcmV0/);
    assert.match(output, /\[redacted\]/);
});

test('createMcpServer requires a client', () => {
    assert.throws(() => createMcpServer({}), ConfigurationError);
});

test('one invocation through the server writes exactly one audit record', async () => {
    const stream = captureStream();
    const client = { request: async () => ({ action: 'nodes', result: 'ok', nodes: {} }) };
    const server = createMcpServer({ client, audit: createAuditLog({ stream }) });

    const result = await server.registry.call('mesh_list_devices', {});

    assert.equal(result.isError, undefined);
    assert.equal(stream.lines.length, 1);
    const record = JSON.parse(stream.lines[0]);
    assert.equal(record.tool, 'mesh_list_devices');
    assert.equal(record.target, 'all');
    assert.equal(record.outcome, 'ok');
    assert.equal(typeof record.durationMs, 'number');
    assert.equal(record.reason, null);
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('a failing invocation is audited with the error reason', async () => {
    const stream = captureStream();
    const client = { request: async () => { throw new Error('Access denied'); } };
    const server = createMcpServer({ client, audit: createAuditLog({ stream }) });

    await server.registry.call('mesh_list_devices', {});

    const record = JSON.parse(stream.lines[0]);
    assert.equal(record.outcome, 'error');
    assert.equal(record.reason, 'Access denied');
});

test('the entry point exits non-zero with an actionable message on invalid configuration', { timeout: 15000 }, async () => {
    const result = await runChild(['--commandtimeout', 'soon'], 5000);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /meshcentral-mcp: Invalid --commandtimeout value "soon"/);
});

test('the entry point fails fast when the server is unreachable', { timeout: 15000 }, async () => {
    const port = await closedPort();
    const result = await runChild(['--url', 'ws://127.0.0.1:' + port, '--connecttimeout', '1000'], 5000);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unable to connect to ws:\/\/127\.0\.0\.1:/);
});

test('the entry point reports authentication failures actionably', { timeout: 15000 }, async (t) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    t.after(() => new Promise((done) => {
        for (const socket of wss.clients) { socket.terminate(); }
        wss.close(done);
    }));
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ action: 'close', cause: 'noauth', msg: 'tokenrequired' }));
        ws.close();
    });

    const result = await runChild(['--url', 'ws://127.0.0.1:' + wss.address().port, '--loginuser', 'admin', '--loginpass', 'wrong', '--connecttimeout', '2000'], 5000);

    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Authentication token required, use --token \[number\]\./);
});

test('startup failures redact credentials carried in the url', { timeout: 15000 }, async () => {
    const port = await closedPort();
    const result = await runChild(['--url', 'ws://127.0.0.1:' + port + '?key=SECRETLOGINKEY', '--connecttimeout', '1000'], 5000);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /SECRETLOGINKEY/);
    assert.match(result.stderr, /\[redacted\]/);
});

test('--help prints usage to stderr without touching stdout', { timeout: 15000 }, async () => {
    const result = await runChild(['--help'], 5000);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: meshcentral-mcp/);
    assert.match(result.stderr, /--connecttimeout/);
});

test('--version prints the package version to stderr without touching stdout', { timeout: 15000 }, async () => {
    const result = await runChild(['--version'], 5000);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, packageJson.version + '\n');
});

test('an MCP client can launch the bridge over stdio, list tools and call mesh_list_devices', { timeout: 20000 }, async (t) => {
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

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_PATH, '--url', 'ws://127.0.0.1:' + wss.address().port, '--connecttimeout', '3000', '--commandtimeout', '3000'],
        stderr: 'pipe'
    });
    let stderr = '';
    transport.stderr.on('data', (chunk) => { stderr += chunk; });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'mesh_list_devices'));
    assert.ok(listed.tools.some((tool) => tool.name === 'mesh_desktop_snapshot'));

    const result = await client.callTool({ name: 'mesh_list_devices', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /host-alpha/);
    assert.match(result.content[0].text, /host-beta/);

    await client.close();

    const records = stderr.trim().split('\n').slice(1).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'mesh_list_devices');
    assert.equal(records[0].target, 'all');
    assert.equal(records[0].outcome, 'ok');
    assert.match(records[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('main resolves the process exit code without hanging when the server is unreachable', { timeout: 15000 }, async () => {
    const port = await closedPort();
    const stderr = captureStream();
    const result = await main(['--url', 'ws://127.0.0.1:' + port, '--connecttimeout', '500'], {}, { stderr });
    assert.equal(result, 1);
    assert.match(stderr.lines.join(''), /meshcentral-mcp: Unable to connect to /);
});
