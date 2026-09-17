'use strict';

/**
 * Tests for the desktop relay launch added to the reusable control client.
 *
 * A local `ws` server replays the control handshake, the authcookie exchange
 * and the tunnel launch message. No live MeshCentral server, no real tokens,
 * node ids or domains.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const {
    MeshCentralClient,
    ConfigurationError,
    ConnectionError,
    TimeoutError,
    RelayError,
    desktopRelayUrl
} = require('../meshcentral-client.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const handshake = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'control-handshake.json'), 'utf8'));

const NODE_ID = 'node//AbCdEf012345';
const TUNNEL_ID = 'tunnel-001';

async function startControlServer(onCommand) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    const messages = [];
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify(handshake.serverinfo));
        ws.send(JSON.stringify(handshake.userinfo));
        ws.on('message', (raw) => {
            let msg = null;
            try { msg = JSON.parse(raw.toString()); } catch (ex) { return; }
            if (msg.action === 'serverversion') {
                ws.send(JSON.stringify(Object.assign({}, handshake.serverversion, { responseid: msg.responseid })));
                return;
            }
            messages.push(msg);
            onCommand(ws, msg);
        });
    });
    return {
        wss,
        messages,
        url: 'ws://127.0.0.1:' + wss.address().port,
        close: () => new Promise((resolve) => {
            for (const client of wss.clients) { client.terminate(); }
            wss.close(resolve);
        })
    };
}

async function startClient(t, server, options) {
    const client = new MeshCentralClient(Object.assign({
        url: server.url,
        password: 'secret',
        connectTimeout: 2000,
        commandTimeout: 2000
    }, options || {}));
    t.after(() => client.close());
    await client.connect();
    return client;
}

function answerCookies(cookie = 'LOGIN-COOKIE', rcookie = 'RELAY-COOKIE') {
    return (ws, msg) => {
        if (msg.action === 'authcookie') {
            ws.send(JSON.stringify({ action: 'authcookie', cookie: cookie, rcookie: rcookie }));
        } else if (msg.action === 'msg') {
            ws.send(JSON.stringify({ action: 'msg', result: 'OK', tag: msg.tag, responseid: msg.responseid }));
        }
    };
}

test('desktop relay: launch requests cookies, routes the tunnel and returns a viewer url', { timeout: 10000 }, async (t) => {
    const server = await startControlServer(answerCookies());
    t.after(() => server.close());
    const client = await startClient(t, server);

    const session = await client.launchDesktopSession(NODE_ID, { id: TUNNEL_ID, imageType: 2, compression: 40 });

    const authcookie = server.messages.find((msg) => msg.action === 'authcookie');
    assert.deepEqual(authcookie, { action: 'authcookie' });

    const tunnel = server.messages.find((msg) => msg.action === 'msg');
    assert.equal(tunnel.type, 'tunnel');
    assert.equal(tunnel.usage, 2);
    assert.equal(tunnel.nodeid, NODE_ID);
    assert.equal(typeof tunnel.responseid, 'string');
    assert.equal(tunnel.value.startsWith('*/meshrelay.ashx?'), true);
    const value = new URL(tunnel.value, 'https://relay.example');
    assert.equal(value.searchParams.get('p'), '2');
    assert.equal(value.searchParams.get('nodeid'), NODE_ID);
    assert.equal(value.searchParams.get('id'), TUNNEL_ID);
    assert.equal(value.searchParams.get('rauth'), 'RELAY-COOKIE');

    const url = new URL(session.url);
    assert.equal(url.pathname, '/meshrelay.ashx');
    assert.equal(url.searchParams.get('browser'), '1');
    assert.equal(url.searchParams.get('p'), '2');
    assert.equal(url.searchParams.get('nodeid'), NODE_ID);
    assert.equal(url.searchParams.get('id'), TUNNEL_ID);
    assert.equal(url.searchParams.get('auth'), 'LOGIN-COOKIE');
    assert.equal(session.nodeid, NODE_ID);
    assert.equal(session.tunnelId, TUNNEL_ID);
    assert.equal(session.cookie, 'LOGIN-COOKIE');
    assert.equal(session.rcookie, 'RELAY-COOKIE');
    assert.equal(session.usage, 2);
    assert.equal(session.response.result, 'OK');
    assert.deepEqual(session.captureConfig, { url: session.url, imageType: 2, compression: 40 });
    assert.equal(session.released, false);
});

test('desktop relay: a bare device id is completed with the serverinfo domain', { timeout: 10000 }, async (t) => {
    const server = await startControlServer(answerCookies());
    t.after(() => server.close());
    const client = await startClient(t, server);
    assert.equal(client.serverInfo.domain, '');

    const session = await client.launchDesktopSession('AbCdEf012345', { id: TUNNEL_ID });

    assert.equal(session.nodeid, 'node//AbCdEf012345');
    const tunnel = server.messages.find((msg) => msg.action === 'msg');
    assert.equal(tunnel.nodeid, 'node//AbCdEf012345');
    assert.equal(new URL(session.url).searchParams.get('nodeid'), 'node//AbCdEf012345');
});

test('desktop relay: pre-fetched cookies skip the authcookie round trip', { timeout: 10000 }, async (t) => {
    const server = await startControlServer(answerCookies());
    t.after(() => server.close());
    const client = await startClient(t, server);

    const auth = await client.authCookie();
    assert.deepEqual(auth, { cookie: 'LOGIN-COOKIE', rcookie: 'RELAY-COOKIE' });
    server.messages.length = 0;

    const session = await client.launchDesktopSession(NODE_ID, { id: TUNNEL_ID, auth: auth });

    assert.equal(server.messages.length, 1);
    assert.equal(server.messages[0].action, 'msg');
    assert.equal(new URL(session.url).searchParams.get('auth'), 'LOGIN-COOKIE');
});

test('desktop relay: a refused tunnel rejects with a RelayError', { timeout: 10000 }, async (t) => {
    const server = await startControlServer((ws, msg) => {
        if (msg.action === 'authcookie') {
            ws.send(JSON.stringify({ action: 'authcookie', cookie: 'LOGIN-COOKIE', rcookie: 'RELAY-COOKIE' }));
        } else if (msg.action === 'msg') {
            ws.send(JSON.stringify({ action: 'msg', result: 'Unable to route', tag: msg.tag, responseid: msg.responseid }));
        }
    });
    t.after(() => server.close());
    const client = await startClient(t, server);

    await assert.rejects(client.launchDesktopSession(NODE_ID, { id: TUNNEL_ID }), (err) => {
        assert.ok(err instanceof RelayError);
        assert.equal(err.code, 'ELAUCHFAILED');
        assert.equal(err.result, 'Unable to route');
        assert.match(err.message, /Unable to route/);
        return true;
    });
});

test('desktop relay: cookies without a matching reply time out', { timeout: 10000 }, async (t) => {
    const server = await startControlServer(() => { /* Never answer the authcookie request */ });
    t.after(() => server.close());
    const client = await startClient(t, server);

    await assert.rejects(client.launchDesktopSession(NODE_ID, { id: TUNNEL_ID, timeout: 120 }), (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.action, 'authcookie');
        return true;
    });
});

test('desktop relay: release closes an attached viewer once and blocks reattachment', { timeout: 10000 }, async (t) => {
    const server = await startControlServer(answerCookies());
    t.after(() => server.close());
    const client = await startClient(t, server);

    const session = await client.launchDesktopSession(NODE_ID, { id: TUNNEL_ID });
    let closes = 0;
    const viewer = { close: async () => { closes++; } };
    assert.equal(session.attach(viewer), viewer);

    await session.release();
    await session.release();
    assert.equal(closes, 1);
    assert.equal(session.released, true);
    assert.throws(() => session.attach(viewer), (err) => {
        assert.ok(err instanceof RelayError);
        assert.equal(err.code, 'ERELEASED');
        return true;
    });
});

test('desktop relay: a launch before connect rejects with a connection error', async () => {
    const client = new MeshCentralClient({ url: 'wss://localhost' });
    await assert.rejects(client.launchDesktopSession(NODE_ID), (err) => {
        assert.ok(err instanceof ConnectionError);
        assert.equal(err.code, 'ENOTCONNECTED');
        return true;
    });
});

test('desktop relay: desktopRelayUrl keeps the domain path and encodes the parameters', () => {
    const url = desktopRelayUrl('wss://mc.example.test:8443/example/control.ashx?key=stale', {
        nodeid: 'node/example/p@th',
        id: 'id 1',
        cookie: 'a+b/c=='
    });
    assert.equal(url, 'wss://mc.example.test:8443/example/meshrelay.ashx?browser=1&p=2&nodeid=node%2Fexample%2Fp%40th&id=id+1&auth=a%2Bb%2Fc%3D%3D');
});

test('desktop relay: desktopRelayUrl rejects a relative control url', () => {
    assert.throws(() => desktopRelayUrl('control.ashx', { nodeid: NODE_ID, id: TUNNEL_ID }), (err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.equal(err.code, 'EINVALIDURL');
        return true;
    });
});
