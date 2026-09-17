'use strict';

/**
 * Tests for the inspection and messaging command tools generated from the
 * catalogue: online user sessions, the account event snapshot, user broadcasts
 * and the two device group messaging commands.
 *
 * Every test injects a fake MeshCentral client into the server factory: no
 * live server, no real tokens, node ids or domains. The fake records the exact
 * action, params and correlation options of every request so the protocol
 * mapping is pinned against the messages meshctrl sends for the same command.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMcpServer } = require('../mcp-server.js');
const catalogue = require('../command-catalogue.js');
const { TimeoutError } = require('../meshcentral-client.js');

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const MESH_BRAVO = 'mesh//MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy';
const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NODE_ALPHA_TWO = 'node//CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const NODE_BRAVO = 'node//BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const INSPECTION_MESSAGING_TOOL_NAMES = [
    'mesh_list_user_sessions',
    'mesh_broadcast',
    'mesh_show_events',
    'mesh_group_toast',
    'mesh_group_message'
];

function createFakeClient(state) {
    state = state || {};
    const requests = [];
    const responses = state.responses || {};
    function respond(action, params) {
        const response = responses[action];
        if (response instanceof Error) { throw response; }
        if (typeof response === 'function') { return response(action, params); }
        if (response !== undefined) { return response; }
        return { action, result: 'ok' };
    }
    return {
        requests,
        async request(action, params, options) {
            const record = { action, params };
            if (options != null) { record.options = options; }
            requests.push(record);
            return respond(action, params);
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

const sessionsFixture = {
    action: 'wssessioncount',
    wssessions: { 'user//pilot': 2, 'user//viewer': 1 }
};

const eventsFixture = {
    action: 'events',
    events: [
        { time: 1700000000000, etype: 'node', action: 'nodeconnect', nodeid: NODE_ALPHA, userid: 'user//pilot', msg: 'Connected' },
        { time: 1700000001000, etype: 'node', action: 'changenode', nodeid: NODE_ALPHA, userid: 'user//pilot', msg: 'Changed' }
    ]
};

const groupNodesFixture = {
    action: 'nodes',
    result: 'ok',
    nodes: {
        [MESH_ALPHA]: [
            { _id: NODE_ALPHA, name: 'host-alpha' },
            { _id: NODE_ALPHA_TWO, name: 'host-alpha-two' }
        ],
        [MESH_BRAVO]: [
            { _id: NODE_BRAVO, name: 'host-beta' }
        ]
    }
};

const emptyNodesFixture = {
    action: 'nodes',
    result: 'ok',
    nodes: { [MESH_ALPHA]: [] }
};

test('the inspection and messaging commands expose one generated tool each', () => {
    const { server } = createServer({});
    const entries = catalogue.commands.filter((entry) =>
        (entry.mcp != null) && INSPECTION_MESSAGING_TOOL_NAMES.includes(entry.mcp.name));
    assert.deepEqual(entries.map((entry) => entry.mcp.name), INSPECTION_MESSAGING_TOOL_NAMES);

    for (const entry of entries) {
        const tool = server.registry.get(entry.mcp.name);
        assert.ok(tool != null, entry.mcp.name + ' is registered');
        const declared = (tool.inputSchema.shape != null) ? Object.keys(tool.inputSchema.shape) : Object.keys(tool.inputSchema);
        assert.deepEqual(declared, entry.args.map((arg) => arg.name), entry.name + ' argument names');
    }
});

test('mesh_list_user_sessions requests the wssessioncount matched on action', async () => {
    const { client, server } = createServer({ responses: { wssessioncount: sessionsFixture } });

    const result = await server.registry.call('mesh_list_user_sessions', {});

    assert.deepEqual(client.requests, [{ action: 'wssessioncount', params: {}, options: { matchAction: true } }]);
    assert.equal(text(result), ['user//pilot, 2 sessions.', 'user//viewer, 1 session.'].join('\n'));
});

test('mesh_list_user_sessions reports an empty session map in words', async () => {
    const { server } = createServer({ responses: { wssessioncount: { action: 'wssessioncount', wssessions: {} } } });

    assert.equal(text(await server.registry.call('mesh_list_user_sessions', {})), 'No active user sessions.');
});

test('mesh_list_user_sessions surfaces a transport failure verbatim', async () => {
    const { server } = createServer({
        responses: { wssessioncount: new TimeoutError('Command "wssessioncount" timed out after 30ms.', 'ETIMEDOUT', 'wssessioncount', 30) }
    });

    const result = await server.registry.call('mesh_list_user_sessions', {});

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'Command "wssessioncount" timed out after 30ms.' }],
        isError: true
    });
});

test('mesh_show_events requests the account event snapshot matched on action', async () => {
    const { client, server } = createServer({ responses: { events: eventsFixture } });

    const result = await server.registry.call('mesh_show_events', {});

    assert.deepEqual(client.requests, [{ action: 'events', params: {}, options: { matchAction: true } }]);
    assert.deepEqual(parseJson(result), eventsFixture.events);
});

test('mesh_show_events filters on the same event actions the CLI filters', async () => {
    const { server } = createServer({ responses: { events: eventsFixture } });

    const one = parseJson(await server.registry.call('mesh_show_events', { filter: 'changenode' }));
    assert.deepEqual(one, [eventsFixture.events[1]]);

    const both = parseJson(await server.registry.call('mesh_show_events', { filter: 'nodeconnect,changenode' }));
    assert.deepEqual(both, eventsFixture.events);
});

test('mesh_show_events reports an empty event snapshot in words', async () => {
    const { server } = createServer({ responses: { events: { action: 'events', events: [] } } });

    assert.equal(text(await server.registry.call('mesh_show_events', {})), 'No events.');
});

test('mesh_show_events surfaces a server denial verbatim', async () => {
    const { server } = createServer({ responses: { events: { action: 'events', result: 'Access denied' } } });

    const result = await server.registry.call('mesh_show_events', {});

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied' }], isError: true });
});

test('mesh_broadcast sends the userbroadcast request meshctrl sends', async () => {
    const { client, server } = createServer({ responses: { userbroadcast: { action: 'userbroadcast', result: 'ok' } } });

    const result = await server.registry.call('mesh_broadcast', { msg: 'Maintenance in 5 minutes' });

    assert.deepEqual(client.requests, [{ action: 'userbroadcast', params: { msg: 'Maintenance in 5 minutes' } }]);
    assert.equal(text(result), 'ok');
});

test('mesh_broadcast directs the message to a single account', async () => {
    const { client, server } = createServer({ responses: { userbroadcast: { action: 'userbroadcast', result: 'ok' } } });

    await server.registry.call('mesh_broadcast', { msg: 'Meeting now', user: 'user//pilot' });

    assert.deepEqual(client.requests, [{ action: 'userbroadcast', params: { msg: 'Meeting now', userid: 'user//pilot' } }]);
});

test('mesh_broadcast surfaces a permission denial verbatim', async () => {
    const { server } = createServer({ responses: { userbroadcast: { action: 'userbroadcast', result: 'Permission denied' } } });

    const result = await server.registry.call('mesh_broadcast', { msg: 'Hello' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Permission denied' }], isError: true });
});

test('mesh_group_message sends one message box request per device in the group', async () => {
    const { client, server } = createServer({ responses: { nodes: groupNodesFixture } });

    const result = await server.registry.call('mesh_group_message', { id: MESH_ALPHA, msg: 'Deploy complete' });

    assert.deepEqual(client.requests, [
        { action: 'nodes', params: { meshid: MESH_ALPHA } },
        { action: 'msg', params: { type: 'messagebox', nodeid: NODE_ALPHA, title: 'MeshCentral', msg: 'Deploy complete', timeout: 120000 } },
        { action: 'msg', params: { type: 'messagebox', nodeid: NODE_ALPHA_TWO, title: 'MeshCentral', msg: 'Deploy complete', timeout: 120000 } },
        { action: 'msg', params: { type: 'messagebox', nodeid: NODE_BRAVO, title: 'MeshCentral', msg: 'Deploy complete', timeout: 120000 } }
    ]);
    assert.equal(text(result), 'Message box sent to 3 devices.');
});

test('mesh_group_message forwards an explicit title and timeout', async () => {
    const { client, server } = createServer({ responses: { nodes: groupNodesFixture } });

    await server.registry.call('mesh_group_message', { id: MESH_ALPHA, msg: 'Reboot now', title: 'Maintenance', timeout: 60000 });

    assert.deepEqual(client.requests[1], {
        action: 'msg',
        params: { type: 'messagebox', nodeid: NODE_ALPHA, title: 'Maintenance', msg: 'Reboot now', timeout: 60000 }
    });
});

test('mesh_group_message reports an empty device group without sending messages', async () => {
    const { client, server } = createServer({ responses: { nodes: emptyNodesFixture } });

    const result = await server.registry.call('mesh_group_message', { id: MESH_ALPHA, msg: 'Hello' });

    assert.deepEqual(client.requests, [{ action: 'nodes', params: { meshid: MESH_ALPHA } }]);
    assert.equal(text(result), 'No devices in this device group.');
});

test('mesh_group_message surfaces a device group denial verbatim', async () => {
    const { server } = createServer({ responses: { nodes: { action: 'nodes', result: 'Unknown device group' } } });

    const result = await server.registry.call('mesh_group_message', { id: MESH_ALPHA, msg: 'Hello' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Unknown device group' }], isError: true });
});

test('mesh_group_message surfaces a routing failure verbatim', async () => {
    const { server } = createServer({
        responses: {
            nodes: groupNodesFixture,
            msg: { action: 'msg', result: 'Unable to route' }
        }
    });

    const result = await server.registry.call('mesh_group_message', { id: MESH_ALPHA, msg: 'Hello' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Unable to route' }], isError: true });
});

test('mesh_group_toast sends one toast request per device group with its device ids', async () => {
    const { client, server } = createServer({ responses: { nodes: groupNodesFixture } });

    const result = await server.registry.call('mesh_group_toast', { id: MESH_ALPHA, msg: 'Deploy complete' });

    assert.deepEqual(client.requests, [
        { action: 'nodes', params: { meshid: MESH_ALPHA } },
        { action: 'toast', params: { nodeids: [NODE_ALPHA, NODE_ALPHA_TWO], title: 'MeshCentral', msg: 'Deploy complete' } },
        { action: 'toast', params: { nodeids: [NODE_BRAVO], title: 'MeshCentral', msg: 'Deploy complete' } }
    ]);
    assert.equal(text(result), 'Toast notification sent to 3 devices.');
});

test('mesh_group_toast forwards an explicit title', async () => {
    const { client, server } = createServer({ responses: { nodes: groupNodesFixture } });

    await server.registry.call('mesh_group_toast', { id: MESH_ALPHA, msg: 'Deploy complete', title: 'Deploy' });

    assert.deepEqual(client.requests[1], {
        action: 'toast',
        params: { nodeids: [NODE_ALPHA, NODE_ALPHA_TWO], title: 'Deploy', msg: 'Deploy complete' }
    });
});

test('mesh_group_toast reports an empty device group without sending toasts', async () => {
    const { client, server } = createServer({ responses: { nodes: emptyNodesFixture } });

    const result = await server.registry.call('mesh_group_toast', { id: MESH_ALPHA, msg: 'Hello' });

    assert.deepEqual(client.requests, [{ action: 'nodes', params: { meshid: MESH_ALPHA } }]);
    assert.equal(text(result), 'No devices in this device group.');
});

test('mesh_group_toast surfaces a routing denial verbatim', async () => {
    const { server } = createServer({
        responses: {
            nodes: groupNodesFixture,
            toast: { action: 'toast', result: 'Access Denied' }
        }
    });

    const result = await server.registry.call('mesh_group_toast', { id: MESH_ALPHA, msg: 'Hello' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access Denied' }], isError: true });
});

test('the messaging tools audit their target', async () => {
    const { server, records } = createServer({ responses: { nodes: groupNodesFixture, userbroadcast: { action: 'userbroadcast', result: 'ok' } } });

    await server.registry.call('mesh_broadcast', { msg: 'Hello' });
    await server.registry.call('mesh_broadcast', { msg: 'Hello', user: 'user//pilot' });
    await server.registry.call('mesh_group_message', { id: MESH_ALPHA, msg: 'Hello' });
    await server.registry.call('mesh_group_toast', { id: MESH_BRAVO, msg: 'Hello' });
    await server.registry.call('mesh_show_events', { filter: 'nodeconnect' });

    assert.deepEqual(records.map((record) => record.tool), [
        'mesh_broadcast',
        'mesh_broadcast',
        'mesh_group_message',
        'mesh_group_toast',
        'mesh_show_events'
    ]);
    assert.deepEqual(records.map((record) => record.target), [
        'all',
        'user//pilot',
        MESH_ALPHA,
        MESH_BRAVO,
        'nodeconnect'
    ]);
});

test('argument validation is generated for the messaging tools', async () => {
    const { client, server } = createServer({});

    const broadcast = await server.registry.call('mesh_broadcast', {});
    assert.equal(broadcast.isError, true);
    assert.match(broadcast.content[0].text, /Invalid arguments for mesh_broadcast/);
    assert.match(broadcast.content[0].text, /msg/);

    const message = await server.registry.call('mesh_group_message', { msg: 'Hello' });
    assert.equal(message.isError, true);
    assert.match(message.content[0].text, /Invalid arguments for mesh_group_message/);
    assert.match(message.content[0].text, /id/);

    const toast = await server.registry.call('mesh_group_toast', { id: MESH_ALPHA });
    assert.equal(toast.isError, true);
    assert.match(toast.content[0].text, /Invalid arguments for mesh_group_toast/);
    assert.match(toast.content[0].text, /msg/);

    assert.deepEqual(client.requests, []);
});
