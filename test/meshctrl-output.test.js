'use strict';

/**
 * Byte-identical CLI output fixtures.
 *
 * The generated catalogue dispatch must print exactly what the hand-written
 * CLI printed for the same server responses. The fixture file was captured
 * from the legacy implementation before the catalogue dispatch landed; this
 * test replays the same fake server and compares stdout, byte for byte.
 *
 * Run with MESHCTRL_CAPTURE=1 to (re)write the fixture file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const MESHCTRL = path.join(__dirname, '..', 'meshctrl.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'cli-output.json');

const handshake = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'control-handshake.json'), 'utf8'));

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const MESH_BRAVO = 'mesh//MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy';
const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NODE_BRAVO = 'node//BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const FIXTURES = {
    serverinfo: handshake.serverinfo,
    userinfo: handshake.userinfo,
    serverversion: handshake.serverversion,
    users: {
        action: 'users',
        users: [
            { _id: 'user//pilot', name: 'pilot', email: 'pilot@example.test', otpsecret: 'sanitised' },
            { _id: 'user//viewer', name: 'viewer' }
        ]
    },
    meshes: {
        action: 'meshes',
        meshes: [
            { _id: MESH_ALPHA, name: 'Alpha Group', desc: 'First group', links: { 'user//pilot': { rights: 0xFFFFFFFF }, 'user//viewer': { rights: 256 } } },
            { _id: MESH_BRAVO, name: 'Bravo Group', links: {} }
        ]
    },
    nodes: {
        action: 'nodes',
        result: 'ok',
        nodes: {
            [MESH_ALPHA]: [{ _id: NODE_ALPHA, name: 'host-alpha', icon: 2, conn: 1, pwr: 1, tags: ['existing'] }],
            [MESH_BRAVO]: [{ _id: NODE_BRAVO, name: 'host-beta', conn: 0, pwr: 0 }]
        }
    },
    wssessioncount: {
        action: 'wssessioncount',
        wssessions: { 'user//pilot': 2, 'user//viewer': 1 }
    },
    events: {
        action: 'events',
        events: [
            { time: 1700000000000, etype: 'node', action: 'nodeconnect', nodeid: NODE_ALPHA, userid: 'user//pilot', msg: 'Connected' },
            { time: 1700000001000, etype: 'user', action: 'changenode', nodeid: NODE_BRAVO, userid: 'user//viewer', msg: 'Changed' }
        ]
    },
    usergroups: {
        action: 'usergroups',
        ugroups: {
            'ugrp//operators': {
                name: 'operators',
                desc: 'Operators',
                links: {
                    'user//pilot': { rights: 1 },
                    [MESH_ALPHA]: { rights: 8 },
                    [NODE_ALPHA]: { rights: 8 }
                }
            }
        }
    },
    loginTokens: {
        action: 'loginTokens',
        loginTokens: [
            { name: 'ci token', tokenUser: '~t:abcdef', expire: 0 },
            { name: 'short token', tokenUser: '~t:ghijkl', expire: 1700000000000 }
        ]
    },
    createLoginToken: {
        action: 'createLoginToken',
        name: 'ci token',
        created: 1700000000000,
        expire: 1700003600000,
        tokenUser: '~t:abcdef',
        tokenPass: 'sanitised-password'
    },
    getnetworkinfo: {
        action: 'getnetworkinfo',
        netif2: [[{ family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', gateway: '10.0.0.1', mac: '00:11:22:33:44:55' }]]
    },
    lastconnect: { action: 'lastconnect', time: 1700000000000, addr: '10.0.0.5:1234' },
    getsysinfo: {
        action: 'getsysinfo',
        node: { _id: NODE_ALPHA, name: 'host-alpha', conn: 1, osdesc: 'Windows 11', agent: { id: 4, ver: 1234 } },
        hardware: {
            windows: { osinfo: { OSArchitecture: 'x64' } },
            identifiers: { bios_vendor: 'Example', bios_version: '1.0', board_vendor: 'Example', board_name: 'Board' },
            tpm: { SpecVersion: '2.0', ManufacturerId: 'EXAMPLE', IsActivated: true }
        }
    },
    report: {
        action: 'report',
        data: {
            columns: [{ id: 'user' }, { id: 'sessions' }],
            groups: { 'user//pilot': { entries: [{ user: 'user//pilot', sessions: 3 }] } }
        }
    },
    deviceShares: {
        action: 'deviceShares',
        deviceShares: [
            {
                publicid: 'abc123',
                p: 3,
                viewOnly: true,
                consent: 0x0001,
                userid: 'user//pilot',
                guestName: 'Guest',
                startTime: 1700000000000,
                expireTime: 1700003600000,
                duration: 60,
                recurring: 1,
                url: 'https://mc.example.test/share'
            }
        ]
    }
};

// Tests default to the fixture for each request action; a case may override
// or omit them. `null` means the server sends no reply.
const GENERIC_OK_ACTIONS = [
    'adduser', 'edituser', 'deleteuser', 'createmesh', 'deletemesh', 'editmesh',
    'addmeshuser', 'removemeshuser', 'adddeviceuser', 'createusergroup', 'deleteusergroup',
    'userbroadcast', 'inviteAgent', 'changeDeviceMesh', 'removedevices', 'addlocaldevice',
    'addamtdevice', 'msg', 'toast', 'poweraction', 'createDeviceShareLink', 'webrelay',
    'addusertousergroup', 'removeuserfromusergroup'
];

const DEFAULT_RESPONSES = {
    serverversion: FIXTURES.serverversion,
    users: FIXTURES.users,
    meshes: FIXTURES.meshes,
    nodes: FIXTURES.nodes,
    wssessioncount: FIXTURES.wssessioncount,
    events: FIXTURES.events,
    usergroups: FIXTURES.usergroups,
    loginTokens: FIXTURES.loginTokens,
    createLoginToken: FIXTURES.createLoginToken,
    getnetworkinfo: FIXTURES.getnetworkinfo,
    lastconnect: FIXTURES.lastconnect,
    getsysinfo: FIXTURES.getsysinfo,
    report: FIXTURES.report,
    deviceShares: FIXTURES.deviceShares
};

const CASES = [
    { name: 'serverinfo', argv: ['serverinfo'] },
    { name: 'serverinfo json', argv: ['serverinfo', '--json'] },
    { name: 'userinfo', argv: ['userinfo'] },
    { name: 'serverversion', argv: ['serverversion'] },
    { name: 'listusers', argv: ['listusers'] },
    { name: 'listusers json', argv: ['listusers', '--json'] },
    { name: 'listusers filter', argv: ['listusers', '--filter', '2fa'] },
    { name: 'listusers idexists', argv: ['listusers', '--idexists', 'pilot'] },
    { name: 'listusers nameexists', argv: ['listusers', '--nameexists', 'viewer'] },
    { name: 'listusersessions', argv: ['listusersessions'] },
    { name: 'listusersessions empty', argv: ['listusersessions'], responses: { wssessioncount: { action: 'wssessioncount', wssessions: {} } } },
    { name: 'listusers nameexists missing', argv: ['listusers', '--nameexists', 'nobody'] },
    { name: 'listusergroups', argv: ['listusergroups'] },
    { name: 'listusergroups json', argv: ['listusergroups', '--json'] },
    { name: 'listdevicegroups', argv: ['listdevicegroups'] },
    { name: 'listdevicegroups hex', argv: ['listdevicegroups', '--hex'] },
    { name: 'listdevicegroups idexists', argv: ['listdevicegroups', '--idexists', 'missing'] },
    { name: 'listdevicegroups nameexists missing', argv: ['listdevicegroups', '--nameexists', 'Missing'] },
    { name: 'listusersofdevicegroup', argv: ['listusersofdevicegroup', '--id', MESH_ALPHA] },
    { name: 'listusersofdevicegroup short', argv: ['listusersofdevicegroup', '--id', MESH_ALPHA.substring(6)] },
    { name: 'listusersofdevicegroup json', argv: ['listusersofdevicegroup', '--id', MESH_ALPHA, '--json'] },
    { name: 'listevents json', argv: ['listevents', '--json'] },
    { name: 'listevents raw', argv: ['listevents', '--raw'] },
    { name: 'logintokens', argv: ['logintokens'] },
    { name: 'logintokens add', argv: ['logintokens', '--add', 'ci token'] },
    { name: 'logintokens json', argv: ['logintokens', '--json'] },
    { name: 'logintokens add json', argv: ['logintokens', '--add', 'ci token', '--json'] },
    { name: 'deviceinfo', argv: ['deviceinfo', '--id', NODE_ALPHA] },
    { name: 'deviceinfo json', argv: ['deviceinfo', '--id', NODE_ALPHA, '--json'] },
    { name: 'deviceinfo raw', argv: ['deviceinfo', '--id', NODE_ALPHA, '--raw'] },
    { name: 'adduser', argv: ['adduser', '--user', 'bob', '--pass', 'secret', '--realname', 'Bob', '--rights', 'full'] },
    { name: 'edituser', argv: ['edituser', '--userid', 'bob', '--email', 'bob@example.test', '--realname', 'Robert'] },
    { name: 'removeuser', argv: ['removeuser', '--userid', 'bob'] },
    { name: 'adddevicegroup', argv: ['adddevicegroup', '--name', 'New Group', '--desc', 'Desc', '--features', '1', '--consent', '63'] },
    { name: 'removedevicegroup', argv: ['removedevicegroup', '--id', MESH_ALPHA] },
    { name: 'editdevicegroup', argv: ['editdevicegroup', '--id', MESH_ALPHA, '--name', 'Renamed', '--consent', '63', '--invitecodes', 'aa,bb', '--backgroundonly'] },
    { name: 'broadcast', argv: ['broadcast', '--msg', 'hello'] },
    { name: 'addusertodevicegroup', argv: ['addusertodevicegroup', '--id', MESH_ALPHA, '--userid', 'user//bob', '--fullrights'] },
    { name: 'removeuserfromdevicegroup', argv: ['removeuserfromdevicegroup', '--id', MESH_ALPHA, '--userid', 'user//bob'] },
    { name: 'addusertodevice', argv: ['addusertodevice', '--id', NODE_ALPHA, '--userid', 'user//bob', '--remotecontrol'] },
    { name: 'removeuserfromdevice', argv: ['removeuserfromdevice', '--id', NODE_ALPHA, '--userid', 'user//bob'] },
    { name: 'sendinviteemail', argv: ['sendinviteemail', '--id', MESH_ALPHA, '--email', 'bob@example.test', '--name', 'Bob', '--message', 'Install'] },
    { name: 'generateinvitelink', argv: ['generateinvitelink', '--id', MESH_ALPHA, '--hours', '24'], responses: { createInviteLink: { action: 'createInviteLink', url: 'https://mc.example.test/invite' } } },
    { name: 'movetodevicegroup', argv: ['movetodevicegroup', '--id', MESH_ALPHA, '--devid', NODE_ALPHA] },
    { name: 'addlocaldevice', argv: ['addlocaldevice', '--id', MESH_ALPHA, '--devicename', 'local', '--hostname', '10.0.0.9', '--type', '4'] },
    { name: 'addamtdevice', argv: ['addamtdevice', '--id', MESH_ALPHA, '--devicename', 'amt', '--hostname', '10.0.0.9', '--user', 'admin', '--pass', 'secret'] },
    { name: 'addusergroup', argv: ['addusergroup', '--name', 'Operators'] },
    { name: 'removeusergroup', argv: ['removeusergroup', '--groupid', 'ugrp//operators'] },
    { name: 'addtousergroup', argv: ['addtousergroup', '--id', 'user//bob', '--groupid', 'ugrp//operators'] },
    { name: 'removefromusergroup', argv: ['removefromusergroup', '--id', 'user//bob', '--groupid', 'ugrp//operators'] },
    { name: 'removeallusersfromusergroup', argv: ['removeallusersfromusergroup', '--groupid', 'ugrp//operators'], responses: { usergroups: { action: 'usergroups', ugroups: { 'ugrp//operators': { name: 'operators', links: { 'user//pilot': { rights: 1 } } } } }, removeuserfromusergroup: { action: 'removeuserfromusergroup', result: 'ok' } } },
    { name: 'runcommand', argv: ['runcommand', '--id', NODE_ALPHA, '--run', 'whoami'], responses: { runcommands: { action: 'runcommands', result: 'OK' } } },
    { name: 'runcommand reply', argv: ['runcommand', '--id', NODE_ALPHA, '--run', 'whoami', '--reply'], responses: { runcommands: { action: 'msg', type: 'runcommands', result: 'pilot' } } },
    { name: 'deviceopenurl', argv: ['deviceopenurl', '--id', NODE_ALPHA, '--openurl', 'https://example.test'] },
    { name: 'devicemessage', argv: ['devicemessage', '--id', NODE_ALPHA, '--msg', 'hello'] },
    { name: 'devicetoast', argv: ['devicetoast', '--id', NODE_ALPHA, '--msg', 'hello'] },
    { name: 'groupmessage', argv: ['groupmessage', '--id', MESH_ALPHA, '--msg', 'hello'] },
    { name: 'grouptoast', argv: ['grouptoast', '--id', MESH_ALPHA, '--msg', 'hello'] },
    { name: 'devicepower wake', argv: ['devicepower', '--id', NODE_ALPHA, '--wake'], responses: { wakedevices: { action: 'wakedevices', result: 'Used 1 device(s) to send wake packets' } } },
    { name: 'devicepower off', argv: ['devicepower', '--id', NODE_ALPHA, '--off'] },
    { name: 'webrelay', argv: ['webrelay', '--id', NODE_ALPHA, '--type', 'http', '--port', '8080'], responses: { webrelay: { action: 'webrelay', result: 'OK', url: 'https://mc.example.test/relay' } } },
    { name: 'devicesharing list', argv: ['devicesharing', '--id', NODE_ALPHA] },
    { name: 'devicesharing add', argv: ['devicesharing', '--id', NODE_ALPHA, '--add', 'Guest', '--type', 'desktop,terminal', '--duration', '30'], responses: { createDeviceShareLink: { action: 'createDeviceShareLink', result: 'OK', publicid: 'abc123', url: 'https://mc.example.test/share' } } },
    { name: 'devicesharing remove', argv: ['devicesharing', '--id', NODE_ALPHA, '--remove', 'abc123'], responses: { removeDeviceShare: { action: 'removeDeviceShare', result: 'ok' } } },
    { name: 'report', argv: ['report', '--type', 'sessions', '--start', '2026-01-01T00:00:00Z', '--end', '2026-01-02T00:00:00Z'] },
    // Exception commands: the hand-written path the catalogue cannot express.
    { name: 'config missing', argv: ['config', '--show'] },
    { name: 'shell missing id', argv: ['shell'] },
    { name: 'upload missing file', argv: ['upload', '--id', NODE_ALPHA] },
    { name: 'download missing target', argv: ['download', '--id', NODE_ALPHA, '--file', 'remote.txt'] },
    { name: 'editdevice missing id', argv: ['editdevice'] },
    { name: 'listdevices', argv: ['listdevices'] },
    { name: 'listdevices json', argv: ['listdevices', '--json'] },
    { name: 'listdevices csv', argv: ['listdevices', '--csv'] },
    { name: 'listdevices id', argv: ['listdevices', '--id', MESH_ALPHA] },
    { name: 'editdevice desc', argv: ['editdevice', '--id', NODE_ALPHA, '--desc', 'New description'], responses: { changedevice: { action: 'changedevice', result: 'ok' } } },
    { name: 'editdevice addtag', argv: ['editdevice', '--id', NODE_ALPHA, '--addtag', 'alpha'], responses: { changedevice: { action: 'changedevice', result: 'ok' } } }
];

function caseResponses(entry) {
    const responses = {};
    for (const action of GENERIC_OK_ACTIONS) { responses[action] = { action: action, result: 'ok' }; }
    Object.assign(responses, DEFAULT_RESPONSES);
    for (const action of (entry.omit || [])) { delete responses[action]; }
    return Object.assign(responses, entry.responses || {});
}

/**
 * Start a fake control server for one case. It performs the handshake, then
 * answers every request with the case fixture (echoing the responseid where
 * the request carried one).
 */
function startServer(responses) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    return new Promise((resolve) => {
        wss.once('listening', () => {
            wss.on('connection', (ws) => {
                ws.send(JSON.stringify(handshake.serverinfo));
                ws.send(JSON.stringify(handshake.userinfo));
                ws.on('message', (raw) => {
                    let msg = null;
                    try { msg = JSON.parse(raw.toString()); } catch (ex) { return; }
                    const response = responses[msg.action];
                    if (response == null) { return; }
                    const payload = Object.assign({}, response);
                    if (msg.responseid != null) { payload.responseid = msg.responseid; }
                    ws.send(JSON.stringify(payload));
                });
            });
            resolve({
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

function runCli(entry, server) {
    const cliArgs = [MESHCTRL].concat(entry.argv).concat([
        '--url', server.url,
        '--loginuser', 'admin',
        '--loginpass', 'secret'
    ]);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, cliArgs, {
            env: Object.assign({}, process.env, { TZ: 'UTC' })
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code, stdout: stdout, stderr: stderr });
        });
    });
}

test('the CLI prints the recorded legacy bytes for the generated command set', { timeout: 120000 }, async (t) => {
    const capture = process.env.MESHCTRL_CAPTURE === '1';
    const recorded = capture ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

    for (const entry of CASES) {
        await t.test(entry.name, { timeout: 10000 }, async (t) => {
            const server = await startServer(caseResponses(entry));
            t.after(() => server.close());
            const result = await runCli(entry, server);
            const actual = { code: result.code, stdout: result.stdout, stderr: result.stderr };
            if (capture) {
                recorded[entry.name] = actual;
                return;
            }
            assert.ok(recorded[entry.name] != null, 'no recorded output for ' + entry.name);
            assert.deepEqual(actual, recorded[entry.name]);
        });
    }

    if (capture) { fs.writeFileSync(FIXTURE, JSON.stringify(recorded, null, 2) + '\n'); }
});
