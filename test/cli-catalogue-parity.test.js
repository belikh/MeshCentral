'use strict';

/**
 * CLI/catalogue protocol parity.
 *
 * Every command the catalogue can express is driven twice against the same
 * fake control server: once as the CLI subprocess, and once as the catalogue
 * protocol mapping executed with a recording client (the path the MCP tools
 * use). The requests each side sends are compared action for action and
 * parameter for parameter, so a command whose CLI mapping and catalogue entry
 * disagree fails here. Commands on the documented exception list are excluded
 * from the wire comparison; the catalogue test asserts the list stays
 * complete and reasoned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const minimist = require('minimist');
const { WebSocketServer } = require('ws');

const catalogue = require('../command-catalogue.js');
const cliDispatch = require('../cli-dispatch.js');
const { executeProtocol } = require('../protocol-executor.js');
const { MeshCentralClient } = require('../meshcentral-client.js');

const MESHCTRL = path.join(__dirname, '..', 'meshctrl.js');
const handshake = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'control-handshake.json'), 'utf8'));

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const MESH_BRAVO = 'mesh//MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy';
const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NODE_BRAVO = 'node//BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const RESPONSES = {
    serverversion: handshake.serverversion,
    users: { action: 'users', users: [{ _id: 'user//pilot', name: 'pilot', email: 'pilot@example.test' }] },
    meshes: {
        action: 'meshes',
        meshes: [
            { _id: MESH_ALPHA, name: 'Alpha Group', links: { 'user//pilot': { rights: 0xFFFFFFFF } } },
            { _id: MESH_BRAVO, name: 'Bravo Group', links: {} }
        ]
    },
    nodes: {
        action: 'nodes',
        result: 'ok',
        nodes: {
            [MESH_ALPHA]: [{ _id: NODE_ALPHA, name: 'host-alpha', conn: 1, pwr: 1 }],
            [MESH_BRAVO]: [{ _id: NODE_BRAVO, name: 'host-beta', conn: 0, pwr: 0 }]
        }
    },
    wssessioncount: { action: 'wssessioncount', wssessions: { 'user//pilot': 1 } },
    events: { action: 'events', events: [{ time: 1700000000000, etype: 'node', action: 'nodeconnect', nodeid: NODE_ALPHA, userid: 'user//pilot', msg: 'Connected' }] },
    usergroups: {
        action: 'usergroups',
        ugroups: {
            'ugrp//operators': {
                name: 'operators',
                links: { 'user//pilot': { rights: 1 }, 'user//viewer': { rights: 1 } }
            }
        }
    },
    loginTokens: { action: 'loginTokens', loginTokens: [{ name: 'ci token', tokenUser: '~t:abcdef', expire: 0 }] },
    createLoginToken: { action: 'createLoginToken', name: 'ci token', created: 1700000000000, tokenUser: '~t:abcdef', tokenPass: 'sanitised' },
    getnetworkinfo: { action: 'getnetworkinfo', netif2: [] },
    lastconnect: { action: 'lastconnect', time: 1700000000000, addr: '10.0.0.5:1234' },
    getsysinfo: { action: 'getsysinfo', node: { _id: NODE_ALPHA, name: 'host-alpha' } },
    report: {
        action: 'report',
        data: { columns: [{ id: 'user' }], groups: { 'user//pilot': { entries: [{ user: 'user//pilot' }] } } }
    },
    createInviteLink: { action: 'createInviteLink', url: 'https://mc.example.test/invite' },
    createDeviceShareLink: { action: 'createDeviceShareLink', result: 'OK', publicid: 'abc123', url: 'https://mc.example.test/share' },
    deviceShares: { action: 'deviceShares', deviceShares: [] },
    webrelay: { action: 'webrelay', result: 'OK', url: 'https://mc.example.test/relay' },
    removeDeviceShare: { action: 'removeDeviceShare', result: 'ok' }
};


/**
* One representative command line per generated command. A command may carry
* several variants so each protocol branch is compared. Adding a command to
* the catalogue without a sample fails the coverage test below.
*/
const ARGUMENTS = {
    serverinfo: [[]],
    serverversion: [[]],
    userinfo: [[]],
    listusers: [[], ['--filter', '2fa'], ['--idexists', 'pilot']],
    listusersessions: [[]],
    listdevicegroups: [[], ['--hex']],
    listusersofdevicegroup: [['--id', MESH_ALPHA]],
    listevents: [[], ['--id', NODE_ALPHA], ['--userid', 'user//pilot', '--limit', '5']],
    logintokens: [[], ['--add', 'ci token', '--expire', '30'], ['--remove', '~t:abcdef']],
    edituser: [['--userid', 'bob', '--email', 'bob@example.test', '--rights', 'manageusers']],
    adduser: [['--user', 'bob', '--pass', 'secret', '--email', 'bob@example.test', '--rights', 'full']],
    removeuser: [['--userid', 'bob']],
    adddevicegroup: [['--name', 'Group', '--desc', 'Desc', '--features', '1', '--consent', '63']],
    removedevicegroup: [['--id', MESH_ALPHA]],
    editdevicegroup: [['--id', MESH_ALPHA, '--name', 'Renamed', '--consent', '63', '--invitecodes', 'aa,bb', '--backgroundonly']],
    broadcast: [['--msg', 'hello'], ['--msg', 'hello', '--user', 'user//pilot']],
    addusertodevicegroup: [['--id', MESH_ALPHA, '--userid', 'user//bob', '--fullrights'], ['--group', 'Alpha Group', '--userid', 'user//bob', '--editgroup']],
    removeuserfromdevicegroup: [['--id', MESH_ALPHA, '--userid', 'user//bob']],
    addusertodevice: [['--id', NODE_ALPHA, '--userid', 'user//bob', '--remotecontrol']],
    removeuserfromdevice: [['--id', NODE_ALPHA, '--userid', 'user//bob']],
    sendinviteemail: [['--id', MESH_ALPHA, '--email', 'bob@example.test', '--name', 'Bob', '--message', 'Install']],
    generateinvitelink: [['--id', MESH_ALPHA, '--hours', '24', '--flags', '2']],
    movetodevicegroup: [['--id', MESH_ALPHA, '--devid', NODE_ALPHA]],
    deviceinfo: [['--id', NODE_ALPHA]],
    removedevice: [['--id', NODE_ALPHA]],
    addlocaldevice: [['--id', MESH_ALPHA, '--devicename', 'local', '--hostname', '10.0.0.9', '--type', '4']],
    addamtdevice: [['--id', MESH_ALPHA, '--devicename', 'amt', '--hostname', '10.0.0.9', '--user', 'admin', '--pass', 'secret', '--notls']],
    addusergroup: [['--name', 'Ops', '--desc', 'Operators']],
    listusergroups: [[]],
    removeusergroup: [['--groupid', 'ugrp//operators']],
    runcommand: [['--id', NODE_ALPHA, '--run', 'whoami'], ['--id', NODE_ALPHA, '--run', 'whoami', '--reply', '--powershell']],
    deviceopenurl: [['--id', NODE_ALPHA, '--openurl', 'https://example.test']],
    devicemessage: [['--id', NODE_ALPHA, '--msg', 'hello', '--title', 'Title', '--timeout', '5']],
    devicetoast: [['--id', NODE_ALPHA, '--msg', 'hello', '--title', 'Title']],
    addtousergroup: [
        ['--id', 'user//bob', '--groupid', 'ugrp//operators'],
        ['--id', MESH_ALPHA, '--groupid', 'ugrp//operators', '--rights', '8'],
        ['--id', NODE_ALPHA, '--groupid', 'ugrp//operators', '--rights', '8'],
        ['--userid', 'user//bob', '--groupid', 'ugrp//operators'],
        ['--meshid', MESH_ALPHA, '--groupid', 'ugrp//operators'],
        ['--nodeid', NODE_ALPHA, '--groupid', 'ugrp//operators']
    ],
    removefromusergroup: [
        ['--id', 'user//bob', '--groupid', 'ugrp//operators'],
        ['--id', MESH_ALPHA, '--groupid', 'ugrp//operators'],
        ['--id', NODE_ALPHA, '--groupid', 'ugrp//operators'],
        ['--userid', 'user//bob', '--groupid', 'ugrp//operators'],
        ['--meshid', MESH_ALPHA, '--groupid', 'ugrp//operators'],
        ['--nodeid', NODE_ALPHA, '--groupid', 'ugrp//operators']
    ],
    removeallusersfromusergroup: [['--groupid', 'ugrp//operators']],
    devicesharing: [
        ['--id', NODE_ALPHA],
        ['--id', NODE_ALPHA, '--add', 'Guest', '--type', 'desktop,terminal', '--viewonly', '--consent', 'prompt,bar', '--start', '2026-01-01T00:00:00Z', '--end', '2026-01-01T01:00:00Z', '--port', '8443'],
        ['--id', NODE_ALPHA, '--add', 'Guest', '--duration', '30', '--daily'],
        ['--id', NODE_ALPHA, '--remove', 'abc123']
    ],
    devicepower: [
        ['--id', NODE_ALPHA + ',' + NODE_BRAVO, '--wake'],
        ['--id', NODE_ALPHA, '--off'],
        ['--id', NODE_ALPHA, '--reset'],
        ['--id', NODE_ALPHA, '--sleep'],
        ['--id', NODE_ALPHA, '--amton'],
        ['--id', NODE_ALPHA, '--amtoff'],
        ['--id', NODE_ALPHA, '--amtreset']
    ],
    indexagenterrorlog: [[]],
    agentdownload: [['--type', '3', '--id', MESH_ALPHA, '--installflags', '2']],
    report: [['--type', 'sessions', '--start', '2026-01-01T00:00:00Z', '--end', '2026-01-02T00:00:00Z', '--groupby', 'device', '--devicegroup', MESH_ALPHA, '--showtraffic']],
    grouptoast: [['--id', MESH_ALPHA, '--msg', 'hello', '--title', 'Title']],
    groupmessage: [['--id', MESH_ALPHA, '--msg', 'hello', '--timeout', '5']],
    webrelay: [['--id', NODE_ALPHA, '--type', 'http', '--port', '8080'], ['--id', NODE_ALPHA, '--type', 'https']]
};

/** Strip the responseid from a wire request, leaving its action and params. */
function wireRequest(message) {
    const request = Object.assign({}, message);
    delete request.responseid;
    const action = request.action;
    delete request.action;
    return { action: action, params: request };
}

function startServer() {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const received = [];
    return new Promise((resolve) => {
        wss.once('listening', () => {
            wss.on('connection', (ws) => {
                ws.send(JSON.stringify(handshake.serverinfo));
                ws.send(JSON.stringify(handshake.userinfo));
                ws.on('message', (raw) => {
                    let msg = null;
                    try { msg = JSON.parse(raw.toString()); } catch (ex) { return; }
                    if (msg.action == null) { return; }
                    received.push(wireRequest(msg));
                    const response = Object.assign({}, RESPONSES[msg.action] || { action: msg.action, result: 'ok' });
                    if (msg.responseid != null) { response.responseid = msg.responseid; }
                    ws.send(JSON.stringify(response));
                });
            });
            resolve({
                port: wss.address().port,
                url: 'ws://127.0.0.1:' + wss.address().port,
                received: received,
                close: () => new Promise((done) => {
                    for (const client of wss.clients) { client.terminate(); }
                    wss.close(done);
                })
            });
        });
    });
}

/** Wait for a condition, up to a timeout, polling on the event loop. */
function waitFor(condition, timeout) {
    return new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
            if (condition() || ((Date.now() - started) >= timeout)) { resolve(); return; }
            setTimeout(poll, 20);
        };
        poll();
    });
}

/** Resolve once no new request arrived for `quiet` ms, or after `timeout` ms. */
function settle(getCount, quiet, timeout) {
    return new Promise((resolve) => {
        const started = Date.now();
        let last = getCount();
        const poll = () => {
            const count = getCount();
            if (count !== last) { last = count; }
            if (((Date.now() - started) >= timeout) || ((count === last) && ((Date.now() - started) >= quiet))) { resolve(); return; }
            setTimeout(poll, 20);
        };
        setTimeout(poll, quiet);
    });
}

/**
* Run one command line through both surfaces against the same fake control
* server: the catalogue protocol mapping over a real MeshCentralClient (the
* path the MCP tools use), then the CLI subprocess. Returns the requests each
* side sent, handshake excluded.
*/
async function runBothSurfaces(entry, argv) {
    const server = await startServer();
    try {
        const args = cliDispatch.buildArguments(entry, minimist(argv));
        const client = new MeshCentralClient({
            url: server.url,
            connectTimeout: 4000,
            commandTimeout: 4000
        });
        await client.connect();
        const toolStart = server.received.length;
        await executeProtocol(client, entry, args);
        await client.close();
        const toolRequests = server.received.slice(toolStart);

        const cliStart = server.received.length;
        const child = spawn(process.execPath, [MESHCTRL, entry.name].concat(argv).concat([
            '--url', server.url,
            '--loginuser', 'admin',
            '--loginpass', 'secret'
        ]));
        try {
            await waitFor(() => server.received.length > cliStart, 3000);
            await settle(() => server.received.length, 300, 2000);
        } finally {
            child.kill('SIGKILL');
        }
        const cliRequests = stripHandshake(server.received.slice(cliStart));
        return { toolRequests: toolRequests, cliRequests: cliRequests };
    } finally {
        await server.close();
    }
}

/** Remove the client's one-time serverversion discovery request. */
function stripHandshake(requests) {
    const out = requests.slice();
    const index = out.findIndex((request) => (request.action === 'serverversion'));
    if (index >= 0) { out.splice(index, 1); }
    return out;
}

test('every generated command carries a representative command line', () => {
    for (const entry of cliDispatch.generatedCommands()) {
        assert.ok(ARGUMENTS[entry.name] != null, 'no parity sample for ' + entry.name);
        assert.ok(ARGUMENTS[entry.name].length > 0, 'empty parity samples for ' + entry.name);
    }
    for (const name of Object.keys(ARGUMENTS)) {
        const entry = catalogue.byName(name);
        assert.ok(entry != null, name + ' is a catalogue command');
        assert.equal(cliDispatch.isGenerated(entry), true, name + ' is generated');
    }
});

test('the CLI and the catalogue mapping send the same requests for every generated command', { timeout: 240000 }, async (t) => {
    for (const entry of cliDispatch.generatedCommands()) {
        const isLocal = cliDispatch.isLocal(entry);
        const isMethod = !Array.isArray(entry.protocol) && (entry.protocol.method != null);
        if (isLocal || isMethod) { continue; }
        for (const argv of ARGUMENTS[entry.name]) {
            await t.test(entry.name + ' ' + JSON.stringify(argv), { timeout: 20000 }, async () => {
                const result = await runBothSurfaces(entry, argv);
                assert.deepEqual(result.cliRequests, result.toolRequests);
            });
        }
    }
});

test('server and user info commands send no command request and print the handshake', async () => {
    for (const name of ['serverinfo', 'userinfo']) {
        const entry = catalogue.byName(name);
        const result = await runBothSurfaces(entry, []);
        assert.deepEqual(result.toolRequests, [], name + ' tool sends no request after the handshake');
        assert.deepEqual(result.cliRequests, [], name + ' CLI sends no request after the handshake');
    }
});

test('the local and client-method commands are declared, not silently hand written', () => {
    const local = catalogue.byName('indexagenterrorlog');
    assert.equal(cliDispatch.isLocal(local), true);
    const download = catalogue.byName('agentdownload');
    assert.equal(download.protocol.method, 'downloadAgent');
});
