'use strict';

/**
 * Tests for the device action tools generated from the command catalogue:
 * remote command execution, power actions, toast/message/open-url, device
 * sharing links, agent download, agent error-log indexing and web relay.
 *
 * Every test injects a fake MeshCentral client into the server factory: no
 * live server, no real tokens, node ids or domains. The fake records the exact
 * action and params of every request so the protocol mapping is pinned to the
 * messages meshctrl sends. The one local entry is exercised against a
 * temporary agent error log, sanitised and synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createMcpServer } = require('../mcp-server.js');
const { TimeoutError } = require('../meshcentral-client.js');

const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NODE_BRAVO = 'node//BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';

const DEVICE_TOOLS = [
    'mesh_run_command',
    'mesh_shell',
    'mesh_device_open_url',
    'mesh_device_message',
    'mesh_device_toast',
    'mesh_device_sharing',
    'mesh_device_power',
    'mesh_index_agent_error_log',
    'mesh_agent_download',
    'mesh_web_relay'
];

function createFakeClient(state) {
    state = state || {};
    const requests = [];
    const methods = [];
    const responses = state.responses || {};
    const client = {
        requests,
        methods,
        serverInfo: (state.serverInfo !== undefined) ? state.serverInfo : null,
        userInfo: (state.userInfo !== undefined) ? state.userInfo : null,
        async request(action, params, options) {
            const record = { action, params };
            if (options != null) { record.options = options; }
            requests.push(record);
            const response = responses[action];
            if (response instanceof Error) { throw response; }
            if (typeof response === 'function') { return response(action, params); }
            if (response !== undefined) { return response; }
            return { action, result: 'ok' };
        },
        async downloadAgent(params) {
            methods.push({ method: 'downloadAgent', params });
            if (state.downloadError != null) { throw state.downloadError; }
            return (state.downloadResult != null)
                ? state.downloadResult
                : { filename: 'meshagent-test.bin', path: '/sanitised/meshagent-test.bin', size: 1234 };
        }
    };
    return client;
}

function createServer(state) {
    const records = [];
    const client = createFakeClient(state);
    const server = createMcpServer({ client, audit: { record: (record) => records.push(record) } });
    return { client, server, records };
}

function text(result) {
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result.content[0].text;
}

test('the registry exposes every device action tool from the catalogue', () => {
    const { server } = createServer({});
    const names = server.registry.list().map((tool) => tool.name);
    for (const name of DEVICE_TOOLS) { assert.ok(names.includes(name), name); }
});

test('device action tool schemas are generated from the catalogue arguments', () => {
    const { server } = createServer({});

    assert.deepEqual(Object.keys(server.registry.get('mesh_run_command').inputSchema), ['id', 'run', 'powershell', 'runasuser', 'runasuseronly', 'reply']);
    assert.deepEqual(Object.keys(server.registry.get('mesh_device_power').inputSchema), ['id', 'wake', 'off', 'reset', 'sleep', 'amton', 'amtoff', 'amtreset']);
    assert.deepEqual(Object.keys(server.registry.get('mesh_agent_download').inputSchema), ['type', 'id', 'installflags']);
    assert.deepEqual(Object.keys(server.registry.get('mesh_index_agent_error_log').inputSchema.shape || server.registry.get('mesh_index_agent_error_log').inputSchema), []);
});

test('mesh_run_command sends the runcommands request meshctrl sends', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'echo hello' });

    assert.deepEqual(client.requests, [{
        action: 'runcommands',
        params: { nodeids: [NODE_ALPHA], type: 0, cmds: 'echo hello', runAsUser: 0, reply: false }
    }]);
});

test('mesh_run_command maps powershell, run-as-user and reply flags', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'Get-Process', powershell: true, runasuser: true, reply: true });

    assert.deepEqual(client.requests[0].params, { nodeids: [NODE_ALPHA], type: 2, cmds: 'Get-Process', runAsUser: 1, reply: true });
});

test('mesh_run_command reports acceptance when output was not requested', async () => {
    const { client, server } = createServer({ responses: { runcommands: { action: 'runcommands', result: 'OK' } } });

    const result = await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'echo hello' });

    assert.equal(text(result), 'Command accepted by the server; output was not requested. Re-run with reply true to capture it.');
    assert.equal(client.requests.length, 1);
});

test('mesh_run_command returns the command output at completion when reply is true', async () => {
    const { server } = createServer({ responses: { runcommands: { action: 'msg', type: 'runcommands', result: 'hello world\n' } } });

    const result = await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'echo hello world', reply: true });

    assert.equal(text(result), 'hello world\n');
});

test('mesh_run_command reports an empty completion reply in words', async () => {
    const { server } = createServer({ responses: { runcommands: { action: 'msg', type: 'runcommands', result: '' } } });

    const result = await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'true', reply: true });

    assert.equal(text(result), 'Command completed with no output.');
});

test('mesh_run_command surfaces a server rejection verbatim', async () => {
    const { server } = createServer({ responses: { runcommands: { action: 'runcommands', result: 'Access denied' } } });

    const result = await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'whoami' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied' }], isError: true });
});

test('mesh_run_command surfaces a command timeout verbatim', async () => {
    const { server } = createServer({ responses: { runcommands: new TimeoutError('Command "runcommands" timed out after 30ms.', 'ETIMEDOUT', 'runcommands', 30) } });

    const result = await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'long', reply: true });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Command "runcommands" timed out after 30ms.' }], isError: true });
});

test('mesh_shell runs one command and waits for its output', async () => {
    const { client, server } = createServer({ responses: { runcommands: { action: 'msg', type: 'runcommands', result: 'total 0\n' } } });

    const result = await server.registry.call('mesh_shell', { id: NODE_ALPHA, run: 'ls -la' });

    assert.deepEqual(client.requests, [{
        action: 'runcommands',
        params: { nodeids: [NODE_ALPHA], type: 0, cmds: 'ls -la', runAsUser: 0, reply: true }
    }]);
    assert.equal(text(result), 'total 0\n');
});

test('mesh_shell maps powershell and run-as-user-only flags', async () => {
    const { client, server } = createServer({ responses: { runcommands: { action: 'msg', type: 'runcommands', result: 'ok' } } });

    await server.registry.call('mesh_shell', { id: NODE_ALPHA, run: 'whoami', powershell: true, runasuseronly: true });

    assert.deepEqual(client.requests[0].params, { nodeids: [NODE_ALPHA], type: 2, cmds: 'whoami', runAsUser: 2, reply: true });
});

test('mesh_device_power wakes one or more devices through wakedevices', async () => {
    const { client, server } = createServer({ responses: { wakedevices: { action: 'wakedevices', result: 'Used 2 device(s) to send wake packets' } } });

    const result = await server.registry.call('mesh_device_power', { id: NODE_ALPHA + ',' + NODE_BRAVO, wake: true });

    assert.deepEqual(client.requests, [{ action: 'wakedevices', params: { nodeids: [NODE_ALPHA, NODE_BRAVO] } }]);
    assert.equal(text(result), 'Used 2 device(s) to send wake packets');
});

test('mesh_device_power maps every power action to the meshctrl action type', async () => {
    const cases = [
        { arg: { off: true }, action: 'poweraction', actiontype: 2 },
        { arg: { reset: true }, action: 'poweraction', actiontype: 3 },
        { arg: { sleep: true }, action: 'poweraction', actiontype: 4 },
        { arg: { amton: true }, action: 'poweraction', actiontype: 302 },
        { arg: { amtoff: true }, action: 'poweraction', actiontype: 308 },
        { arg: { amtreset: true }, action: 'poweraction', actiontype: 310 }
    ];
    for (const entry of cases) {
        const { client, server } = createServer({ responses: { poweraction: { action: 'poweraction', result: 'ok' } } });
        await server.registry.call('mesh_device_power', Object.assign({ id: NODE_ALPHA }, entry.arg));
        assert.deepEqual(client.requests, [{ action: entry.action, params: { nodeids: [NODE_ALPHA], actiontype: entry.actiontype } }], JSON.stringify(entry.arg));
        assert.equal(client.requests.length, 1);
    }
});

test('mesh_device_power reports acceptance of agent power actions', async () => {
    const { server } = createServer({ responses: { poweraction: { action: 'poweraction', result: 'ok' } } });

    const result = await server.registry.call('mesh_device_power', { id: NODE_ALPHA, sleep: true });

    assert.equal(text(result), 'Power action accepted by the server.');
});

test('mesh_device_power surfaces a wake failure verbatim as an error', async () => {
    const { server } = createServer({ responses: { wakedevices: { action: 'wakedevices', result: 'No known MAC addresses for this device' } } });

    const result = await server.registry.call('mesh_device_power', { id: NODE_ALPHA, wake: true });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'No known MAC addresses for this device' }], isError: true });
});

test('mesh_device_power requires exactly one power action and sends nothing otherwise', async () => {
    const { client, server } = createServer({});

    const none = await server.registry.call('mesh_device_power', { id: NODE_ALPHA });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /A power action is required/);

    const both = await server.registry.call('mesh_device_power', { id: NODE_ALPHA, reset: true, off: true });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /Specify only one power action/);

    assert.deepEqual(client.requests, []);
});

test('mesh_device_toast sends the toast request meshctrl sends', async () => {
    const { client, server } = createServer({ responses: { toast: { action: 'toast', result: 'ok' } } });

    const result = await server.registry.call('mesh_device_toast', { id: NODE_ALPHA, msg: 'Build finished' });

    assert.deepEqual(client.requests, [{ action: 'toast', params: { nodeids: [NODE_ALPHA], title: 'MeshCentral', msg: 'Build finished' } }]);
    assert.equal(text(result), 'Toast notification sent to the device.');
});

test('mesh_device_toast forwards an explicit title', async () => {
    const { client, server } = createServer({ responses: { toast: { action: 'toast', result: 'ok' } } });

    await server.registry.call('mesh_device_toast', { id: NODE_ALPHA, msg: 'Build finished', title: 'Deploy' });

    assert.deepEqual(client.requests[0].params, { nodeids: [NODE_ALPHA], title: 'Deploy', msg: 'Build finished' });
});

test('mesh_device_message sends the messagebox request meshctrl sends', async () => {
    const { client, server } = createServer({ responses: { msg: { action: 'msg', result: 'OK' } } });

    const result = await server.registry.call('mesh_device_message', { id: NODE_ALPHA, msg: 'Reboot in 5 minutes' });

    assert.deepEqual(client.requests, [{
        action: 'msg',
        params: { type: 'messagebox', nodeid: NODE_ALPHA, title: 'MeshCentral', msg: 'Reboot in 5 minutes', timeout: 120000 }
    }]);
    assert.equal(text(result), 'Message box sent to the device.');
});

test('mesh_device_message forwards an explicit title and timeout', async () => {
    const { client, server } = createServer({ responses: { msg: { action: 'msg', result: 'OK' } } });

    await server.registry.call('mesh_device_message', { id: NODE_ALPHA, msg: 'Reboot now', title: 'Maintenance', timeout: 60000 });

    assert.deepEqual(client.requests[0].params, { type: 'messagebox', nodeid: NODE_ALPHA, title: 'Maintenance', msg: 'Reboot now', timeout: 60000 });
});

test('mesh_device_open_url sends the openUrl request meshctrl sends', async () => {
    const { client, server } = createServer({ responses: { msg: { action: 'msg', result: 'OK' } } });

    const result = await server.registry.call('mesh_device_open_url', { id: NODE_ALPHA, openurl: 'https://example.test/runbook' });

    assert.deepEqual(client.requests, [{
        action: 'msg',
        params: { type: 'openUrl', nodeid: NODE_ALPHA, url: 'https://example.test/runbook' }
    }]);
    assert.equal(text(result), 'Open URL request sent to the device.');
});

test('mesh_device_message surfaces a routing failure verbatim', async () => {
    const { server } = createServer({ responses: { msg: { action: 'msg', result: 'Unable to route' } } });

    const result = await server.registry.call('mesh_device_message', { id: NODE_ALPHA, msg: 'Hello' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Unable to route' }], isError: true });
});

test('mesh_device_sharing lists links by matching the action response', async () => {
    const { client, server } = createServer({
        responses: {
            deviceShares: {
                action: 'deviceShares',
                nodeid: NODE_ALPHA,
                deviceShares: [{
                    p: 3,
                    viewOnly: false,
                    consent: 0x0009,
                    publicid: 'share-alpha',
                    userid: 'user//pilot',
                    guestName: 'Guest Alpha',
                    startTime: 1700000000000,
                    expireTime: 1700003600000,
                    url: 'https://mc.example.test/sharing?c=sanitised'
                }]
            }
        }
    });

    const result = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA });

    assert.deepEqual(client.requests, [{ action: 'deviceShares', params: { nodeid: NODE_ALPHA }, options: { matchAction: true } }]);
    assert.equal(text(result), [
        '----------',
        'Identifier:   share-alpha',
        'Type:         Terminal + Desktop',
        'UserId:       user//pilot',
        'Guest Name:   Guest Alpha',
        'User Consent: Desktop Notify, Desktop Prompt',
        'Start Time:   2023-11-14T22:13:20.000Z',
        'Expire Time:  2023-11-14T23:13:20.000Z',
        'URL:          https://mc.example.test/sharing?c=sanitised'
    ].join('\n'));
});

test('mesh_device_sharing reports a device with no sharing links', async () => {
    const { server } = createServer({ responses: { deviceShares: { action: 'deviceShares', nodeid: NODE_ALPHA, deviceShares: [] } } });

    const result = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA });

    assert.equal(text(result), 'No device sharing links for this device.');
});

test('mesh_device_sharing adds an unlimited desktop link with CLI defaults', async () => {
    const { client, server } = createServer({
        responses: { createDeviceShareLink: { action: 'createDeviceShareLink', result: 'OK', publicid: 'pid-alpha', url: 'https://mc.example.test/sharing?c=alpha' } }
    });

    const result = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, add: 'Guest' });

    assert.deepEqual(client.requests, [{
        action: 'createDeviceShareLink',
        params: {
            nodeid: NODE_ALPHA,
            guestname: 'Guest',
            p: 2,
            consent: 0x0001,
            expire: 0,
            viewOnly: false,
            port: null
        }
    }]);
    assert.equal(text(result), 'ID: pid-alpha\nURL: https://mc.example.test/sharing?c=alpha');
});

test('mesh_device_sharing derives types, consent and a fixed time range', async () => {
    const { client, server } = createServer({
        responses: { createDeviceShareLink: { action: 'createDeviceShareLink', result: 'OK', publicid: 'pid-bravo', url: 'https://mc.example.test/sharing?c=bravo' } }
    });

    await server.registry.call('mesh_device_sharing', {
        id: NODE_ALPHA,
        add: 'Guest Bravo',
        type: 'desktop,terminal',
        viewonly: true,
        consent: 'prompt',
        start: '2026-09-17T10:00:00Z',
        end: '2026-09-17T11:00:00Z'
    });

    const start = Math.floor(Date.parse('2026-09-17T10:00:00Z') / 1000);
    const end = Math.floor(Date.parse('2026-09-17T11:00:00Z') / 1000);
    assert.deepEqual(client.requests[0].params, {
        nodeid: NODE_ALPHA,
        guestname: 'Guest Bravo',
        p: 3,
        consent: 0x0018,
        start: start,
        end: end,
        viewOnly: true,
        port: null
    });
});

test('mesh_device_sharing derives a duration from a start time', async () => {
    const { client, server } = createServer({
        responses: { createDeviceShareLink: { action: 'createDeviceShareLink', result: 'OK', publicid: 'pid-charlie', url: 'https://mc.example.test/sharing?c=charlie' } }
    });

    await server.registry.call('mesh_device_sharing', {
        id: NODE_ALPHA,
        add: 'Guest Charlie',
        start: '2026-09-17T10:00:00Z',
        duration: 30
    });

    const start = Math.floor(Date.parse('2026-09-17T10:00:00Z') / 1000);
    assert.deepEqual(client.requests[0].params, {
        nodeid: NODE_ALPHA,
        guestname: 'Guest Charlie',
        p: 2,
        consent: 0x0001,
        start: start,
        end: start + (30 * 60),
        viewOnly: false,
        port: null
    });
});

test('mesh_device_sharing builds a recurring daily link and a web link port', async () => {
    const { client, server } = createServer({
        responses: { createDeviceShareLink: { action: 'createDeviceShareLink', result: 'OK', publicid: 'pid-delta', url: 'https://mc.example.test/sharing?c=delta' } }
    });

    await server.registry.call('mesh_device_sharing', {
        id: NODE_ALPHA,
        add: 'Guest Delta',
        type: 'http',
        start: '2026-09-17T10:00:00Z',
        duration: 45,
        daily: true,
        port: 8080
    });

    const start = Math.floor(Date.parse('2026-09-17T10:00:00Z') / 1000);
    assert.deepEqual(client.requests[0].params, {
        nodeid: NODE_ALPHA,
        guestname: 'Guest Delta',
        p: 8,
        consent: 0,
        start: start,
        expire: 45,
        recurring: 1,
        viewOnly: false,
        port: 8080
    });
});

test('mesh_device_sharing refuses conflicting and unknown share options', async () => {
    const { client, server } = createServer({});

    const both = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, add: 'Guest', daily: true, weekly: true });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /daily and --weekly/);

    const type = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, add: 'Guest', type: 'bmp' });
    assert.equal(type.isError, true);
    assert.match(type.content[0].text, /Unknown sharing type: bmp/);

    const consent = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, add: 'Guest', consent: 'maybe' });
    assert.equal(consent.isError, true);
    assert.match(consent.content[0].text, /Unknown consent type/);

    const port = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, add: 'Guest', type: 'https', port: 70000 });
    assert.equal(port.isError, true);
    assert.match(port.content[0].text, /Port number must be between 1 and 65535/);

    assert.deepEqual(client.requests, []);
});

test('mesh_device_sharing removes a link and reports an unknown identifier', async () => {
    const removed = { action: 'removeDeviceShare', nodeid: NODE_ALPHA, publicid: 'share-alpha', removed: { publicid: 'share-alpha' } };
    const { client, server } = createServer({ responses: { removeDeviceShare: removed } });

    const result = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, remove: 'share-alpha' });
    assert.deepEqual(client.requests, [{ action: 'removeDeviceShare', params: { nodeid: NODE_ALPHA, publicid: 'share-alpha' } }]);
    assert.equal(text(result), 'Sharing link removed.');

    const missing = createServer({ responses: { removeDeviceShare: { action: 'removeDeviceShare', nodeid: NODE_ALPHA, publicid: 'nope', removed: null } } });
    const failure = await missing.server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, remove: 'nope' });
    assert.deepEqual(failure, { content: [{ type: 'text', text: 'Invalid device share identifier.' }], isError: true });
});

test('mesh_device_sharing surfaces a server rejection verbatim', async () => {
    const { server } = createServer({ responses: { createDeviceShareLink: { action: 'createDeviceShareLink', result: 'Access denied' } } });

    const result = await server.registry.call('mesh_device_sharing', { id: NODE_ALPHA, add: 'Guest' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied' }], isError: true });
});

test('mesh_web_relay requests a relay with the CLI protocol defaults', async () => {
    const { client, server } = createServer({
        responses: { webrelay: { action: 'webrelay', result: 'OK', url: 'https://mc.example.test/control-redirect.ashx?n=sanitised' } }
    });

    const result = await server.registry.call('mesh_web_relay', { id: NODE_ALPHA, type: 'http' });

    assert.deepEqual(client.requests, [{ action: 'webrelay', params: { nodeid: NODE_ALPHA, port: 80, appid: 1 } }]);
    assert.equal(text(result), 'URL: https://mc.example.test/control-redirect.ashx?n=sanitised');
});

test('mesh_web_relay maps https and an explicit port', async () => {
    const { client, server } = createServer({
        responses: { webrelay: { action: 'webrelay', result: 'OK', url: 'https://mc.example.test:8443/control-redirect.ashx?n=sanitised' } }
    });

    await server.registry.call('mesh_web_relay', { id: NODE_ALPHA, type: 'https', port: 8443 });

    assert.deepEqual(client.requests[0].params, { nodeid: NODE_ALPHA, port: 8443, appid: 2 });
});

test('mesh_web_relay refuses unknown protocols and ports', async () => {
    const { client, server } = createServer({});

    const protocol = await server.registry.call('mesh_web_relay', { id: NODE_ALPHA, type: 'ftp' });
    assert.equal(protocol.isError, true);
    assert.match(protocol.content[0].text, /Unknown protocol type: ftp/);

    const port = await server.registry.call('mesh_web_relay', { id: NODE_ALPHA, type: 'http', port: 0 });
    assert.equal(port.isError, true);
    assert.match(port.content[0].text, /Port number must be between 1 and 65535/);

    assert.deepEqual(client.requests, []);
});

test('mesh_web_relay surfaces a disabled relay verbatim', async () => {
    const { server } = createServer({ responses: { webrelay: { action: 'webrelay', result: 'WebRelay Disabled' } } });

    const result = await server.registry.call('mesh_web_relay', { id: NODE_ALPHA, type: 'https' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'WebRelay Disabled' }], isError: true });
});

test('mesh_agent_download calls the client download method with the CLI parameters', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_agent_download', { type: 3, id: MESH_ALPHA });

    assert.deepEqual(client.methods, [{ method: 'downloadAgent', params: { type: 3, meshid: MESH_ALPHA } }]);
    assert.deepEqual(client.requests, []);
    assert.equal(text(result), 'Downloaded 1234 byte(s) to "meshagent-test.bin"');
});

test('mesh_agent_download forwards installer flags and refuses invalid ones', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_agent_download', { type: 3, id: MESH_ALPHA, installflags: 1 });
    assert.deepEqual(client.methods[0].params, { type: 3, meshid: MESH_ALPHA, installflags: 1 });

    const type = await server.registry.call('mesh_agent_download', { type: 0, id: MESH_ALPHA });
    assert.equal(type.isError, true);
    assert.match(type.content[0].text, /Invalid agent type/);

    const flags = await server.registry.call('mesh_agent_download', { type: 3, id: MESH_ALPHA, installflags: 3 });
    assert.equal(flags.isError, true);
    assert.match(flags.content[0].text, /Invalid Installflags/);

    assert.equal(client.methods.length, 1);
});

test('mesh_agent_download surfaces a download failure verbatim', async () => {
    const { server } = createServer({ downloadError: new Error('File "meshagent-test.bin" already exists.') });

    const result = await server.registry.call('mesh_agent_download', { type: 3, id: MESH_ALPHA });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'File "meshagent-test.bin" already exists.' }], isError: true });
});

test('mesh_index_agent_error_log indexes the local agent error log', async (t) => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agent-log-'));
    t.after(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(dir, 'meshcentral-data'));
    const nodeid = 'node//' + 'A'.repeat(64);
    const line = (time, log) => nodeid + ', ' + time + ', ' + JSON.stringify({ action: 'errorlog', log: log });
    const lines = [
        line(1700000000000, [{ t: 1, m: 'STUCK in setup step' }, { t: 2, m: 'ordinary message' }, { t: 3, m: 'STUCK other failure' }]),
        line(1700000001000, [{ t: 4, m: 'FATAL crash' }, { t: 5, m: 'STUCK other failure' }])
    ];
    fs.writeFileSync(path.join(dir, 'meshcentral-data', 'agenterrorlogs.txt'), lines.join('\r\n'));
    process.chdir(dir);

    const { client, server } = createServer({});
    const result = await server.registry.call('mesh_index_agent_error_log', {});

    assert.deepEqual(client.requests, []);
    assert.equal(text(result), '2 STUCK other failure\n1 STUCK in setup step\n1 FATAL crash');
});

test('mesh_index_agent_error_log reports a log with no stuck or fatal errors', async (t) => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agent-log-'));
    t.after(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(dir, 'meshcentral-data'));
    const nodeid = 'node//' + 'B'.repeat(64);
    const line = nodeid + ', 1700000000000, ' + JSON.stringify({ action: 'errorlog', log: [{ t: 1, m: 'ordinary message' }] });
    fs.writeFileSync(path.join(dir, 'meshcentral-data', 'agenterrorlogs.txt'), line + '\r\n');
    process.chdir(dir);

    const { server } = createServer({});
    const result = await server.registry.call('mesh_index_agent_error_log', {});

    assert.equal(text(result), 'No STUCK or FATAL agent error messages found.');
});

test('mesh_index_agent_error_log reports an unreadable log clearly', async (t) => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agent-log-'));
    t.after(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
    process.chdir(dir);

    const { server } = createServer({});
    const result = await server.registry.call('mesh_index_agent_error_log', {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unable to read the agent error log at /);
});

test('device action invocations are audited with their target', async () => {
    const { server, records } = createServer({ responses: { toast: { action: 'toast', result: 'ok' } } });

    await server.registry.call('mesh_device_toast', { id: NODE_ALPHA, msg: 'Hello' });
    await server.registry.call('mesh_agent_download', { type: 3, id: MESH_ALPHA });
    await server.registry.call('mesh_run_command', { id: NODE_ALPHA, run: 'echo hi' });

    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.tool), ['mesh_device_toast', 'mesh_agent_download', 'mesh_run_command']);
    assert.deepEqual(records.map((record) => record.target), [NODE_ALPHA, MESH_ALPHA, NODE_ALPHA]);
    assert.deepEqual(records.map((record) => record.outcome), ['ok', 'ok', 'ok']);
});

test('an MCP client can see and call the device action tools over a transport', async (t) => {
    const { server } = createServer({ responses: { runcommands: { action: 'msg', type: 'runcommands', result: 'hello\n' } } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of DEVICE_TOOLS) { assert.ok(names.includes(name), name); }

    const runCommand = listed.tools.find((tool) => tool.name === 'mesh_run_command');
    assert.deepEqual(runCommand.inputSchema.required, ['id', 'run']);

    const result = await client.callTool({ name: 'mesh_run_command', arguments: { id: NODE_ALPHA, run: 'echo hello', reply: true } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'hello\n');
});
