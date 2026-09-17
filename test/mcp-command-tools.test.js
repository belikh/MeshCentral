'use strict';

/**
 * Tests for the catalogue generated command tools.
 *
 * Every test injects a fake MeshCentral client into the server factory: no
 * live server, no real tokens, node ids or domains. The fake records the exact
 * action and params of every request so the protocol mapping is pinned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createMcpServer } = require('../mcp-server.js');
const catalogue = require('../command-catalogue.js');
const { TimeoutError } = require('../meshcentral-client.js');

const handshake = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'control-handshake.json'), 'utf8'));

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const MESH_BRAVO = 'mesh//MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy';
const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NODE_BRAVO = 'node//BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const TOOL_NAMES = [
    'mesh_edit_user',
    'mesh_list_users',
    'mesh_list_user_sessions',
    'mesh_list_groups',
    'mesh_list_devices',
    'mesh_list_device_group_users',
    'mesh_get_events',
    'mesh_login_tokens',
    'mesh_server_info',
    'mesh_server_version',
    'mesh_user_info',
    'mesh_add_user',
    'mesh_remove_user',
    'mesh_add_device_group',
    'mesh_remove_device_group',
    'mesh_edit_device_group',
    'mesh_broadcast',
    'mesh_show_events',
    'mesh_add_user_to_device_group',
    'mesh_remove_user_from_device_group',
    'mesh_add_user_to_device',
    'mesh_remove_user_from_device',
    'mesh_get_device',
    'mesh_add_user_group',
    'mesh_list_user_groups',
    'mesh_remove_user_group',
    'mesh_run_command',
    'mesh_shell',
    'mesh_device_open_url',
    'mesh_device_message',
    'mesh_device_toast',
    'mesh_add_to_user_group',
    'mesh_remove_from_user_group',
    'mesh_remove_all_users_from_user_group',
    'mesh_device_sharing',
    'mesh_device_power',
    'mesh_index_agent_error_log',
    'mesh_agent_download',
    'mesh_report',
    'mesh_group_toast',
    'mesh_group_message',
    'mesh_web_relay'
];

function createFakeClient(state) {
    state = state || {};
    const requests = [];
    const responses = state.responses || {};
    return {
        requests,
        serverInfo: (state.serverInfo !== undefined) ? state.serverInfo : null,
        userInfo: (state.userInfo !== undefined) ? state.userInfo : null,
        async request(action, params) {
            requests.push({ action, params });
            const response = responses[action];
            if (response instanceof Error) { throw response; }
            if (typeof response === 'function') { return response(action, params); }
            if (response !== undefined) { return response; }
            return { action, result: 'ok' };
        }
    };
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

function parseJson(result) {
    return JSON.parse(text(result));
}

const meshesFixture = {
    action: 'meshes',
    meshes: [
        {
            _id: MESH_ALPHA,
            name: 'Alpha Group',
            links: { 'user//pilot': { rights: 0xFFFFFFFF }, 'user//viewer': { rights: 256 } }
        },
        {
            _id: MESH_BRAVO,
            name: 'Bravo Group',
            links: {}
        }
    ]
};

const usersFixture = {
    action: 'users',
    users: [
        { _id: 'user//pilot', name: 'pilot', email: 'pilot@example.test', otpsecret: 'sanitised' },
        { _id: 'user//viewer', name: 'viewer' }
    ]
};

const userGroupsFixture = {
    action: 'usergroups',
    ugroups: {
        'ugrp//operators': { name: 'operators', desc: 'Operators', links: {} }
    }
};

const eventsFixture = {
    action: 'events',
    events: [
        { time: 1700000000000, etype: 'node', action: 'nodeconnect', nodeid: NODE_ALPHA, userid: 'user//pilot', msg: 'Connected' }
    ]
};

const nodesFixture = {
    action: 'nodes',
    result: 'ok',
    nodes: {
        [MESH_ALPHA]: [{ _id: NODE_ALPHA, name: 'host-alpha', conn: 1, pwr: 1 }],
        [MESH_BRAVO]: [{ _id: NODE_BRAVO, name: 'host-beta', conn: 0, pwr: 0 }]
    }
};

const sysinfoFixture = {
    action: 'getsysinfo',
    node: { _id: NODE_ALPHA, name: 'host-alpha' },
    hardware: { windows: { osinfo: { OSArchitecture: 'x64' } } }
};

const networkFixture = {
    action: 'getnetworkinfo',
    netif2: [[{ family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', gateway: '10.0.0.1', mac: '00:11:22:33:44:55' }]]
};

const lastConnectFixture = { action: 'lastconnect', time: 1700000000000, addr: '10.0.0.5:1234' };

test('the registry exposes one generated tool per catalogue MCP entry', () => {
    const { server } = createServer({});
    assert.deepEqual(server.registry.list().map((tool) => tool.name), TOOL_NAMES);
    assert.deepEqual(server.registry.list().map((tool) => tool.name), catalogue.mcpCommands().map((entry) => entry.mcp.name));
});

test('argument schemas are generated from the catalogue argument definitions', () => {
    const { server } = createServer({});
    for (const entry of catalogue.mcpCommands()) {
        const tool = server.registry.get(entry.mcp.name);
        const declared = (tool.inputSchema.shape != null) ? Object.keys(tool.inputSchema.shape) : Object.keys(tool.inputSchema);
        assert.deepEqual(declared, entry.args.map((arg) => arg.name), entry.name + ' argument names');
    }
});

test('an MCP client sees the generated tool schemas over a transport', async (t) => {
    const { server } = createServer({});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();

    assert.deepEqual(listed.tools.map((tool) => tool.name), TOOL_NAMES);
    const device = listed.tools.find((tool) => tool.name === 'mesh_get_device');
    assert.deepEqual(device.inputSchema.required, ['id']);
    assert.equal(device.inputSchema.properties.id.description, catalogue.byName('deviceinfo').args[0].description);

    const info = listed.tools.find((tool) => tool.name === 'mesh_server_info');
    assert.equal(info.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(info.inputSchema.properties), []);
});

test('mesh_list_groups requests meshes and renders ids and names', async () => {
    const { client, server } = createServer({ responses: { meshes: meshesFixture } });

    const result = await server.registry.call('mesh_list_groups', {});

    assert.deepEqual(client.requests, [{ action: 'meshes', params: {} }]);
    assert.equal(text(result), ['id, name', '"' + MESH_ALPHA + '", "Alpha Group"', '"' + MESH_BRAVO + '", "Bravo Group"'].join('\n'));
});

test('mesh_list_groups answers an id or name existence check', async () => {
    const { server } = createServer({ responses: { meshes: meshesFixture } });

    assert.equal(text(await server.registry.call('mesh_list_groups', { idexists: MESH_ALPHA })), '1');
    assert.equal(text(await server.registry.call('mesh_list_groups', { idexists: 'MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx' })), '1');
    assert.equal(text(await server.registry.call('mesh_list_groups', { idexists: 'missing' })), '0');
    assert.equal(text(await server.registry.call('mesh_list_groups', { nameexists: 'Bravo Group' })), MESH_BRAVO);
    assert.equal(text(await server.registry.call('mesh_list_groups', { nameexists: 'Missing' })), '');
});

test('mesh_list_groups renders hex ids when asked', async () => {
    const { server } = createServer({ responses: { meshes: meshesFixture } });
    const result = await server.registry.call('mesh_list_groups', { hex: true });
    const alphaHex = '0x' + Buffer.from('MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx', 'base64').toString('hex').toUpperCase();
    const bravoHex = '0x' + Buffer.from('MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy', 'base64').toString('hex').toUpperCase();
    assert.equal(text(result), ['id, name', '"' + alphaHex + '", "Alpha Group"', '"' + bravoHex + '", "Bravo Group"'].join('\n'));
});

test('mesh_list_devices forwards a group name and reports a count', async () => {
    const { client, server } = createServer({ responses: { nodes: nodesFixture } });

    await server.registry.call('mesh_list_devices', { group: 'Alpha Group' });
    assert.deepEqual(client.requests, [{ action: 'nodes', params: { meshname: 'Alpha Group' } }]);

    client.requests.length = 0;
    const count = await server.registry.call('mesh_list_devices', { count: true });
    assert.deepEqual(client.requests, [{ action: 'nodes', params: {} }]);
    assert.equal(text(count), '2');
});

test('mesh_get_device issues the four deviceinfo requests', async () => {
    const { client, server } = createServer({
        responses: { nodes: nodesFixture, getnetworkinfo: networkFixture, lastconnect: lastConnectFixture, getsysinfo: sysinfoFixture }
    });

    await server.registry.call('mesh_get_device', { id: NODE_ALPHA });

    assert.deepEqual(client.requests, [
        { action: 'nodes', params: {} },
        { action: 'getnetworkinfo', params: { nodeid: NODE_ALPHA } },
        { action: 'lastconnect', params: { nodeid: NODE_ALPHA } },
        { action: 'getsysinfo', params: { nodeid: NODE_ALPHA, nodeinfo: true } }
    ]);
});

test('mesh_get_device returns node, system, network and last connection as JSON', async () => {
    const { server } = createServer({
        responses: { nodes: nodesFixture, getnetworkinfo: networkFixture, lastconnect: lastConnectFixture, getsysinfo: sysinfoFixture }
    });

    const info = parseJson(await server.registry.call('mesh_get_device', { id: NODE_ALPHA }));

    assert.deepEqual(info.node, { _id: NODE_ALPHA, name: 'host-alpha' });
    assert.deepEqual(info.system, sysinfoFixture);
    assert.deepEqual(info.network, networkFixture);
    assert.deepEqual(info.lastConnect, lastConnectFixture);
});

test('mesh_get_device tolerates an offline device without system or network information', async () => {
    const { server } = createServer({
        responses: {
            nodes: nodesFixture,
            getnetworkinfo: { action: 'getnetworkinfo', result: 'Device is not connected' },
            lastconnect: { action: 'lastconnect', result: 'Device is not connected' },
            getsysinfo: new TimeoutError('Command "getsysinfo" timed out.', 'ETIMEDOUT', 'getsysinfo', 30)
        }
    });

    const info = parseJson(await server.registry.call('mesh_get_device', { id: NODE_ALPHA }));

    assert.deepEqual(info.node, { _id: NODE_ALPHA, name: 'host-alpha', conn: 1, pwr: 1 });
    assert.equal(info.system, undefined);
    assert.equal(info.network, undefined);
    assert.equal(info.lastConnect, undefined);
});

test('mesh_get_device surfaces a nodes error verbatim', async () => {
    const { server } = createServer({ responses: { nodes: { action: 'nodes', result: 'Access denied: missing device group rights' } } });

    const result = await server.registry.call('mesh_get_device', { id: NODE_ALPHA });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied: missing device group rights' }], isError: true });
});

test('mesh_list_users requests users and renders id, name and email', async () => {
    const { client, server } = createServer({ responses: { users: usersFixture } });

    const result = await server.registry.call('mesh_list_users', {});

    assert.deepEqual(client.requests, [{ action: 'users', params: {} }]);
    assert.equal(text(result), ['id, name, email', '"pilot", "pilot", "pilot@example.test"', '"viewer", "viewer"'].join('\n'));
});

test('mesh_list_users filters on two-factor state', async () => {
    const { server } = createServer({ responses: { users: usersFixture } });

    assert.match(text(await server.registry.call('mesh_list_users', { filter: '2fa' })), /pilot/);
    const without2fa = await server.registry.call('mesh_list_users', { filter: 'no2fa' });
    assert.match(text(without2fa), /viewer/);
    assert.doesNotMatch(text(without2fa), /pilot/);
});

test('mesh_list_users answers an id or name existence check', async () => {
    const { server } = createServer({ responses: { users: usersFixture } });

    assert.equal(text(await server.registry.call('mesh_list_users', { idexists: 'user//pilot' })), '1');
    assert.equal(text(await server.registry.call('mesh_list_users', { idexists: 'nobody' })), '0');
    assert.equal(text(await server.registry.call('mesh_list_users', { nameexists: 'viewer' })), 'user//viewer');
});

test('mesh_list_user_groups requests usergroups and returns JSON', async () => {
    const { client, server } = createServer({ responses: { usergroups: userGroupsFixture } });

    const groups = parseJson(await server.registry.call('mesh_list_user_groups', {}));

    assert.deepEqual(client.requests, [{ action: 'usergroups', params: {} }]);
    assert.deepEqual(groups, userGroupsFixture.ugroups);
});

test('mesh_list_device_group_users requests meshes and renders rights', async () => {
    const { client, server } = createServer({ responses: { meshes: meshesFixture } });

    const result = await server.registry.call('mesh_list_device_group_users', { id: MESH_ALPHA });

    assert.deepEqual(client.requests, [{ action: 'meshes', params: {} }]);
    assert.equal(text(result), ['userid, rights', 'pilot, FullAdministrator', 'viewer, RemoteViewOnly'].join('\n'));
});

test('mesh_list_device_group_users reports an unknown group and an empty group', async () => {
    const { server } = createServer({ responses: { meshes: meshesFixture } });

    assert.equal(text(await server.registry.call('mesh_list_device_group_users', { id: 'missing' })), 'Group id not found');
    assert.equal(text(await server.registry.call('mesh_list_device_group_users', { id: MESH_BRAVO })), 'No users in this device group.');
});

test('mesh_get_events requests events filtered by device, user and limit', async () => {
    const { client, server } = createServer({ responses: { events: eventsFixture } });

    await server.registry.call('mesh_get_events', {});
    await server.registry.call('mesh_get_events', { id: NODE_ALPHA, limit: 12 });
    await server.registry.call('mesh_get_events', { userid: 'user//pilot' });

    assert.deepEqual(client.requests, [
        { action: 'events', params: {} },
        { action: 'events', params: { nodeid: NODE_ALPHA, limit: 12 } },
        { action: 'events', params: { user: 'user//pilot' } }
    ]);
});

test('mesh_get_events renders one CSV row per event', async () => {
    const { server } = createServer({ responses: { events: eventsFixture } });

    assert.equal(text(await server.registry.call('mesh_get_events', {})),
        'time,type,action,nodeid,userid,msg\n"1700000000000","node","nodeconnect","' + NODE_ALPHA + '","user//pilot","Connected"');
    assert.equal(text(await server.registry.call('mesh_get_events', { id: NODE_ALPHA })),
        'time,type,action,userid,msg\n"1700000000000","node","nodeconnect","user//pilot","Connected"');
});

test('mesh_server_info returns the handshake server information without a request', async () => {
    const { client, server } = createServer({ serverInfo: handshake.serverinfo.serverinfo });

    const info = parseJson(await server.registry.call('mesh_server_info', {}));

    assert.deepEqual(client.requests, []);
    assert.deepEqual(info, handshake.serverinfo.serverinfo);
});

test('mesh_server_version requests the server version and renders it', async () => {
    const { client, server } = createServer({ responses: { serverversion: handshake.serverversion } });

    const result = await server.registry.call('mesh_server_version', {});

    assert.deepEqual(client.requests, [{ action: 'serverversion', params: {} }]);
    assert.match(text(result), /^MeshCentral version: /);
});

test('mesh_user_info returns the handshake account information without a request', async () => {
    const { client, server } = createServer({ userInfo: handshake.userinfo.userinfo });

    const info = parseJson(await server.registry.call('mesh_user_info', {}));

    assert.deepEqual(client.requests, []);
    assert.deepEqual(info, handshake.userinfo.userinfo);
});

test('mesh_server_info fails clearly when the handshake carried no server information', async () => {
    const { server } = createServer({ serverInfo: null });
    const result = await server.registry.call('mesh_server_info', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /serverInfo/);
});

test('argument validation is generated: a missing required argument is denied', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_get_device', {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments for mesh_get_device/);
    assert.match(result.content[0].text, /id/);
    assert.deepEqual(client.requests, []);
});

test('argument validation is generated: a wrong argument type is denied', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_get_events', { limit: 'soon' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments for mesh_get_events/);
    assert.match(result.content[0].text, /limit/);
    assert.deepEqual(client.requests, []);
});

test('a server error result is surfaced verbatim', async () => {
    const { server } = createServer({ responses: { users: { action: 'users', result: 'Access denied: missing manageusers right' } } });

    const result = await server.registry.call('mesh_list_users', {});

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'Access denied: missing manageusers right' }],
        isError: true
    });
});

test('a transport failure is surfaced verbatim', async () => {
    const { server } = createServer({ responses: { meshes: new TimeoutError('Command "meshes" timed out after 30ms.', 'ETIMEDOUT', 'meshes', 30) } });

    const result = await server.registry.call('mesh_list_groups', {});

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'Command "meshes" timed out after 30ms.' }],
        isError: true
    });
});
