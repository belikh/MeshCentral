'use strict';

/**
 * Tests for the reusable MeshCentral control-protocol client.
 *
 * Every exchange is replayed by a local `ws` server from sanitised fixtures:
 * no live MeshCentral server, no real tokens, node ids or domains.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const { MeshCentralClient, AuthError, TimeoutError, ConnectionError } = require('../meshcentral-client.js');

const MODULE_PATH = path.join(__dirname, '..', 'meshcentral-client.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const handshake = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'control-handshake.json'), 'utf8'));
const nodesFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'nodes.json'), 'utf8'));

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const MESH_BRAVO = 'mesh//MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy';

function createServer(onConnection) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    return new Promise((resolve) => {
        wss.once('listening', () => {
            wss.on('connection', (ws, req) => onConnection(ws, req));
            resolve({
                wss,
                port: wss.address().port,
                url: 'ws://127.0.0.1:' + wss.address().port,
                close: () => new Promise((done) => {
                    for (const client of wss.clients) { client.terminate(); }
                    wss.close(done);
                })
            });
        });
    });
}

function sendHandshake(ws, { serverinfo = handshake.serverinfo, userinfo = handshake.userinfo, serverversion = handshake.serverversion } = {}) {
    ws.send(JSON.stringify(serverinfo));
    ws.send(JSON.stringify(userinfo));
    if (serverversion != null) {
        ws.on('message', (raw) => {
            let msg = null;
            try { msg = JSON.parse(raw.toString()); } catch (ex) { }
            if ((msg != null) && (msg.action === 'serverversion')) {
                ws.send(JSON.stringify(Object.assign({}, serverversion, { responseid: msg.responseid })));
            }
        });
    }
}

function nodesResponse(request, meshid) {
    const response = Object.assign({}, nodesFixture, { responseid: request.responseid });
    response.nodes = { [meshid]: nodesFixture.nodes[meshid] };
    return response;
}

function runChild(script, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script].concat(args || []), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('requiring the module has no CLI side effects', () => {
    const result = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(MODULE_PATH) + ')'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
});

test('connect authenticates, discovers server info, rights and version', { timeout: 10000 }, async (t) => {
    let captured = null;
    const server = await createServer((ws, req) => { captured = req; sendHandshake(ws); });
    t.after(() => server.close());

    const client = new MeshCentralClient({
        url: server.url,
        user: 'admin',
        password: 'secret',
        token: 123456,
        connectTimeout: 2000,
        commandTimeout: 2000
    });
    t.after(() => client.close());

    await client.connect();

    assert.equal(client.authenticated, true);
    assert.equal(client.serverInfo.name, 'mc.example.test');
    assert.equal(client.userInfo._id, 'user//admin');
    assert.equal(client.rights, 4294967295);
    assert.equal(client.serverVersion.current, '1.2.5');
    assert.equal(client.controlUrl, server.url + '/control.ashx');
    assert.equal(
        captured.headers['x-meshauth'],
        Buffer.from('admin').toString('base64') + ',' + Buffer.from('secret').toString('base64') + ',' + Buffer.from('123456').toString('base64')
    );

    await client.close();
    assert.equal(client.authenticated, false);
});

test('concurrent commands each resolve against their own response', { timeout: 10000 }, async (t) => {
    const received = [];
    const server = await createServer((ws) => {
        sendHandshake(ws);
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.action !== 'nodes') return;
            received.push(msg);
            if (received.length === 2) {
                // Answer the second request first so arrival order does not match send order.
                ws.send(JSON.stringify(nodesResponse(received[1], MESH_BRAVO)));
                setTimeout(() => ws.send(JSON.stringify(nodesResponse(received[0], MESH_ALPHA))), 20);
            }
        });
    });
    t.after(() => server.close());

    const client = new MeshCentralClient({ url: server.url, password: 'secret', connectTimeout: 2000, commandTimeout: 2000 });
    t.after(() => client.close());
    await client.connect();

    const alpha = client.request('nodes', { meshid: MESH_ALPHA });
    const bravo = client.request('nodes', { meshid: MESH_BRAVO });
    const [alphaResponse, bravoResponse] = await Promise.all([alpha, bravo]);

    assert.equal(received.length, 2);
    assert.notEqual(received[0].responseid, received[1].responseid);
    assert.equal(alphaResponse.nodes[MESH_ALPHA][0].name, 'host-alpha');
    assert.equal(bravoResponse.nodes[MESH_BRAVO][0].name, 'host-beta');
});

test('a response that does not echo the responseid resolves by action', { timeout: 10000 }, async (t) => {
    const server = await createServer((ws) => {
        sendHandshake(ws);
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.action !== 'loginTokens') return;
            // Unsolicited events and a response without a responseid, exactly
            // as the server answers loginTokens and report commands.
            ws.send(JSON.stringify({ action: 'event', event: { action: 'nodeconnect' } }));
            ws.send(JSON.stringify({ action: 'loginTokens', loginTokens: [{ name: 'ci token', tokenUser: '~t:abcdef', expire: 0 }] }));
        });
    });
    t.after(() => server.close());

    const client = new MeshCentralClient({ url: server.url, password: 'secret', connectTimeout: 2000, commandTimeout: 2000 });
    t.after(() => client.close());
    await client.connect();

    const response = await client.requestByAction('loginTokens', {});

    assert.equal(response.action, 'loginTokens');
    assert.equal(response.loginTokens[0].name, 'ci token');
});

test('an action matched command that never answers rejects with a timeout error', { timeout: 10000 }, async (t) => {
    const server = await createServer((ws) => { sendHandshake(ws); });
    t.after(() => server.close());

    const client = new MeshCentralClient({ url: server.url, password: 'secret', connectTimeout: 2000, commandTimeout: 2000 });
    t.after(() => client.close());
    await client.connect();

    await assert.rejects(client.requestByAction('report', {}, { timeout: 120 }), (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.action, 'report');
        assert.match(err.message, /timed out after 120ms/);
        return true;
    });
});

test('a command that never answers rejects with a timeout error', { timeout: 10000 }, async (t) => {
    const server = await createServer((ws) => { sendHandshake(ws); });
    t.after(() => server.close());

    const client = new MeshCentralClient({ url: server.url, password: 'secret', connectTimeout: 2000, commandTimeout: 2000 });
    t.after(() => client.close());
    await client.connect();

    await assert.rejects(client.request('nodes', { meshid: MESH_ALPHA }, { timeout: 120 }), (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.action, 'nodes');
        assert.match(err.message, /timed out after 120ms/);
        return true;
    });
});

test('a handshake that never completes rejects with a timeout error', { timeout: 10000 }, async (t) => {
    const server = await createServer(() => { /* Accept the socket, never send a handshake */ });
    t.after(() => server.close());

    const client = new MeshCentralClient({ url: server.url, password: 'secret', connectTimeout: 120, commandTimeout: 2000 });
    await assert.rejects(client.connect(), (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.action, 'connect');
        assert.match(err.message, /timed out after 120ms/);
        return true;
    });
});

test('a command issued before connect rejects with a connection error', async () => {
    const client = new MeshCentralClient({ url: 'wss://localhost' });
    await assert.rejects(client.request('nodes', {}), (err) => {
        assert.ok(err instanceof ConnectionError);
        assert.equal(err.code, 'ENOTCONNECTED');
        return true;
    });
});

test('authentication failures reject with an actionable AuthError', { timeout: 20000 }, async (t) => {
    const cases = [
        { close: { cause: 'noauth', msg: 'tokenrequired' }, message: /Authentication token required, use --token \[number\]\./ },
        { close: { cause: 'noauth', msg: 'nokey' }, message: /URL key is invalid or missing, please specify \?key=xxx in url/ },
        { close: { cause: 'noauth' }, message: /^Invalid login\.$/ },
        { close: { cause: 'locked' }, message: /Account locked\. Please contact the administrator\./ },
        { close: { cause: 'banned' }, message: /Access temporarily blocked due to too many failed login attempts\./ },
        { close: { cause: 'noauth' }, config: { loginKey: 'not-a-signed-key' }, message: /Invalid login, check the login key/ }
    ];

    for (const entry of cases) {
        await t.test(JSON.stringify(entry.close), async () => {
            const server = await createServer((ws) => {
                ws.send(JSON.stringify(Object.assign({ action: 'close' }, entry.close)));
                ws.close();
            });
            const client = new MeshCentralClient(Object.assign({
                url: server.url,
                password: 'wrong',
                connectTimeout: 2000,
                commandTimeout: 2000
            }, entry.config || {}));
            try {
                await assert.rejects(client.connect(), (err) => {
                    assert.ok(err instanceof AuthError);
                    assert.match(err.message, entry.message);
                    return true;
                });
            } finally {
                await client.close();
                await server.close();
            }
        });
    }
});

test('an unreachable server rejects with a connection error', { timeout: 10000 }, async () => {
    const probe = await createServer(() => { });
    const port = probe.port;
    await probe.close();

    const client = new MeshCentralClient({ url: 'ws://127.0.0.1:' + port, password: 'secret', connectTimeout: 2000 });
    await assert.rejects(client.connect(), (err) => {
        assert.ok(err instanceof ConnectionError);
        assert.equal(err.code, 'ECONNREFUSED');
        assert.match(err.message, /Unable to connect to ws:\/\/127\.0\.0\.1:/);
        return true;
    });
});

test('a login key file signs an auth cookie for the configured account', { timeout: 10000 }, async (t) => {
    const key = crypto.randomBytes(80);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const keyFile = path.join(dir, 'login.key');
    fs.writeFileSync(keyFile, key.toString('hex').replace(/(.{64})/g, '$1\r\n '));

    let captured = null;
    const server = await createServer((ws, req) => { captured = req; sendHandshake(ws); });
    t.after(() => server.close());

    const client = new MeshCentralClient({
        url: server.url,
        loginKeyFile: keyFile,
        user: 'operator',
        domain: 'example',
        connectTimeout: 2000,
        commandTimeout: 2000
    });
    t.after(() => client.close());
    await client.connect();

    assert.equal(client.controlUrl, server.url + '/control.ashx');
    assert.doesNotMatch(client.controlUrl, /[?&](?:key|auth)=/i);
    assert.match(client.url, /[?&]auth=/);

    const auth = new URL(captured.url, 'ws://localhost').searchParams.get('auth');
    assert.ok(auth != null, 'auth cookie was sent');
    const raw = Buffer.from(auth.replace(/@/g, '+').replace(/\$/g, '/'), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key.subarray(0, 32), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const cookie = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));

    assert.equal(cookie.userid, 'user/example/operator');
    assert.equal(cookie.domainid, 'example');
});

test('a ?key= login key connects but is kept out of the log-safe url', { timeout: 10000 }, async (t) => {
    let captured = null;
    const server = await createServer((ws, req) => { captured = req; sendHandshake(ws); });
    t.after(() => server.close());

    const client = new MeshCentralClient({ url: server.url + '?key=examplekey&auth=examplecookie', password: 'secret', connectTimeout: 2000, commandTimeout: 2000 });
    t.after(() => client.close());
    await client.connect();

    assert.equal(client.controlUrl, server.url + '/control.ashx');
    assert.doesNotMatch(client.controlUrl, /[?&](?:key|auth)=/i);
    const connectionUrl = new URL(captured.url, 'ws://localhost');
    assert.equal(connectionUrl.searchParams.get('key'), 'examplekey');
    assert.equal(connectionUrl.searchParams.get('auth'), 'examplecookie');
    assert.equal(new URL(client.url, 'ws://localhost').searchParams.get('key'), 'examplekey');
});

test('connection errors never carry a url login key or auth cookie', { timeout: 10000 }, async () => {
    const probe = await createServer(() => { });
    const port = probe.port;
    await probe.close();

    const client = new MeshCentralClient({
        url: 'ws://127.0.0.1:' + port + '?key=SECRETLOGINKEY&auth=SECRETCOOKIE',
        password: 'secret',
        connectTimeout: 2000
    });
    await assert.rejects(client.connect(), (err) => {
        assert.ok(err instanceof ConnectionError);
        assert.match(err.message, /Unable to connect to ws:\/\/127\.0\.0\.1:/);
        assert.doesNotMatch(err.message, /SECRETLOGINKEY|SECRETCOOKIE/);
        assert.doesNotMatch(err.message, /[?&](?:key|auth)=/i);
        return true;
    });
    assert.equal(client.controlUrl, 'ws://127.0.0.1:' + port + '/control.ashx');
});

test('a standalone script can connect, run a command and close with no CLI output', { timeout: 10000 }, async (t) => {
    const server = await createServer((ws) => {
        sendHandshake(ws);
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.action === 'nodes') { ws.send(JSON.stringify(nodesResponse(msg, msg.meshid))); }
        });
    });
    t.after(() => server.close());

    const script = [
        "const { MeshCentralClient } = require(" + JSON.stringify(MODULE_PATH) + ");",
        "(async () => {",
        "    const client = new MeshCentralClient({ url: " + JSON.stringify(server.url) + ", connectTimeout: 2000, commandTimeout: 2000 });",
        "    await client.connect();",
        "    const response = await client.request('nodes', { meshid: " + JSON.stringify(MESH_BRAVO) + " });",
        "    process.stdout.write(response.nodes[" + JSON.stringify(MESH_BRAVO) + "][0].name);",
        "    await client.close();",
        "})().catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err)); process.exitCode = 1; });"
    ].join('\n');

    const result = await runChild(script);
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'host-beta');
});
