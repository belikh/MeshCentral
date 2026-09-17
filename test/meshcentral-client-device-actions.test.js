'use strict';

/**
 * Tests for the device action support added to the reusable MeshCentral
 * client: action matched responses (the deviceShares listing carries no
 * responseid) and agent installer downloads.
 *
 * No live server: the control connection is a local `ws` server replaying
 * sanitised frames, and the installer download uses an injected request
 * function and a temporary directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');

const { MeshCentralClient, TimeoutError, agentDownloadUrl } = require('../meshcentral-client.js');

const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function createServer(onConnection) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    return new Promise((resolve) => {
        wss.once('listening', () => {
            wss.on('connection', (ws) => onConnection(ws));
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

function sendHandshake(ws) {
    ws.send(JSON.stringify({ action: 'serverinfo', serverinfo: { name: 'mc.example.test', domain: '' } }));
    ws.send(JSON.stringify({ action: 'userinfo', userinfo: { _id: 'user//operator', siteadmin: 0 } }));
    ws.on('message', (raw) => {
        let msg = null;
        try { msg = JSON.parse(raw.toString()); } catch (ex) { }
        if ((msg != null) && (msg.action === 'serverversion')) {
            ws.send(JSON.stringify({ action: 'serverversion', tags: { current: '1.2.5' }, responseid: msg.responseid }));
        }
    });
}

function createHttpsStub(response) {
    const calls = [];
    const request = (url, options, callback) => {
        calls.push({ url, options });
        const req = new EventEmitter();
        req.setTimeout = (timeout, handler) => { if (response.hang === true) { handler(); } };
        req.destroy = () => {};
        req.end = () => {
            const res = new EventEmitter();
            res.statusCode = response.statusCode;
            res.headers = response.headers || {};
            res.resume = () => {};
            callback(res);
            process.nextTick(() => {
                for (const chunk of response.chunks || []) { res.emit('data', chunk); }
                res.emit('end');
            });
        };
        return req;
    };
    return { request, calls };
}

test('agentDownloadUrl builds the meshagents url meshctrl downloads from', () => {
    assert.equal(
        agentDownloadUrl('wss://mc.example.test/control.ashx', { type: 3, meshid: 'mesh//abc' }),
        'https://mc.example.test/meshagents?id=3&meshid=mesh//abc'
    );
    assert.equal(
        agentDownloadUrl('wss://mc.example.test/control.ashx?key=example', { type: 2, meshid: 'mesh//abc', installflags: 1 }),
        'https://mc.example.test/meshagents?key=example&id=2&meshid=mesh//abc&installflags=1'
    );
});

test('downloadAgent keeps a url login key on the download request', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-download-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stub = createHttpsStub({
        statusCode: 200,
        headers: { 'content-disposition': 'attachment; filename="meshagent-test.bin"' },
        chunks: [Buffer.from('x')]
    });

    const client = new MeshCentralClient({ url: 'wss://mc.example.test?key=SECRETLOGINKEY', commandTimeout: 2000 });
    await client.downloadAgent({ type: 3, meshid: 'mesh//abc', directory: dir, request: stub.request });

    assert.equal(stub.calls[0].url, 'https://mc.example.test/meshagents?key=SECRETLOGINKEY&id=3&meshid=mesh//abc');
    assert.equal(client.controlUrl, 'wss://mc.example.test/control.ashx');
    assert.doesNotMatch(client.controlUrl, /[?&](?:key|auth)=/i);
});

test('a request can match its response by action when the server sends no responseid', { timeout: 10000 }, async (t) => {
    const server = await createServer((ws) => {
        sendHandshake(ws);
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.action !== 'deviceShares') return;
            ws.send(JSON.stringify({ action: 'deviceShares', nodeid: NODE_ALPHA, deviceShares: [] }));
        });
    });
    t.after(() => server.close());

    const client = new MeshCentralClient({ url: server.url, password: 'secret', connectTimeout: 2000, commandTimeout: 2000 });
    t.after(() => client.close());
    await client.connect();

    const response = await client.request('deviceShares', { nodeid: NODE_ALPHA }, { matchAction: true });
    assert.deepEqual(response.deviceShares, []);
});

test('downloadAgent writes the installer and reports its name, path and size', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-download-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stub = createHttpsStub({
        statusCode: 200,
        headers: { 'content-disposition': 'attachment; filename="meshagent-test.bin"' },
        chunks: [Buffer.from('hello')]
    });

    const client = new MeshCentralClient({ url: 'wss://mc.example.test', commandTimeout: 2000 });
    const result = await client.downloadAgent({ type: 3, meshid: 'mesh//abc', installflags: 1, directory: dir, request: stub.request });

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://mc.example.test/meshagents?id=3&meshid=mesh//abc&installflags=1');
    assert.equal(stub.calls[0].options.rejectUnauthorized, false);
    assert.deepEqual(result, {
        filename: 'meshagent-test.bin',
        path: path.join(dir, 'meshagent-test.bin'),
        size: 5
    });
    assert.equal(fs.readFileSync(path.join(dir, 'meshagent-test.bin'), 'utf8'), 'hello');
});

test('downloadAgent keeps the download inside the target directory', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-download-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stub = createHttpsStub({
        statusCode: 200,
        headers: { 'content-disposition': 'attachment; filename="../escape.bin"' },
        chunks: [Buffer.from('x')]
    });

    const client = new MeshCentralClient({ url: 'wss://mc.example.test', commandTimeout: 2000 });
    const result = await client.downloadAgent({ type: 3, meshid: 'mesh//abc', directory: dir, request: stub.request });

    assert.equal(result.filename, 'escape.bin');
    assert.equal(result.path, path.join(dir, 'escape.bin'));
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape.bin')), false);
});

test('downloadAgent refuses to overwrite an existing installer', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-download-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'meshagent-test.bin'), 'existing');
    const stub = createHttpsStub({
        statusCode: 200,
        headers: { 'content-disposition': 'attachment; filename="meshagent-test.bin"' },
        chunks: [Buffer.from('new')]
    });

    const client = new MeshCentralClient({ url: 'wss://mc.example.test', commandTimeout: 2000 });
    await assert.rejects(client.downloadAgent({ type: 3, meshid: 'mesh//abc', directory: dir, request: stub.request }), (error) => {
        assert.equal(error.message, 'File "meshagent-test.bin" already exists.');
        return true;
    });
    assert.equal(fs.readFileSync(path.join(dir, 'meshagent-test.bin'), 'utf8'), 'existing');
});

test('downloadAgent surfaces a non-200 download status verbatim', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-download-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stub = createHttpsStub({ statusCode: 403, headers: {}, chunks: [] });

    const client = new MeshCentralClient({ url: 'wss://mc.example.test', commandTimeout: 2000 });
    await assert.rejects(client.downloadAgent({ type: 3, meshid: 'mesh//abc', directory: dir, request: stub.request }), (error) => {
        assert.equal(error.message, 'Download error, statusCode: 403');
        return true;
    });
});

test('downloadAgent honours the command timeout', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-download-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stub = createHttpsStub({ statusCode: 200, headers: {}, chunks: [], hang: true });

    const client = new MeshCentralClient({ url: 'wss://mc.example.test/control.ashx', commandTimeout: 25 });
    await assert.rejects(client.downloadAgent({ type: 3, meshid: 'mesh//abc', directory: dir, request: stub.request }), (error) => {
        assert.ok(error instanceof TimeoutError);
        assert.equal(error.message, 'Command "agentdownload" timed out after 25ms.');
        return true;
    });
});
