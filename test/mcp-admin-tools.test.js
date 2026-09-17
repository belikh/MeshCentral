'use strict';

/**
 * Tests for the administrative command tools generated from the catalogue.
 *
 * Every test injects a fake MeshCentral client into the server factory: no
 * live server, no real tokens, node ids or domains. The fake records the exact
 * action and params of every request so the protocol mapping is pinned against
 * what meshctrl sends for the same command.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createMcpServer } = require('../mcp-server.js');
const catalogue = require('../command-catalogue.js');
const { TimeoutError } = require('../meshcentral-client.js');

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const ADMIN_TOOL_NAMES = [
    'mesh_edit_user',
    'mesh_login_tokens',
    'mesh_add_user',
    'mesh_remove_user',
    'mesh_add_device_group',
    'mesh_remove_device_group',
    'mesh_edit_device_group',
    'mesh_add_user_to_device_group',
    'mesh_remove_user_from_device_group',
    'mesh_add_user_to_device',
    'mesh_remove_user_from_device',
    'mesh_add_user_group',
    'mesh_remove_user_group',
    'mesh_add_to_user_group',
    'mesh_remove_from_user_group',
    'mesh_remove_all_users_from_user_group',
    'mesh_report'
];

function createFakeClient(state) {
    state = state || {};
    const requests = [];
    const byActionRequests = [];
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
        byActionRequests,
        async request(action, params) { requests.push({ action, params }); return respond(action, params); },
        async requestByAction(action, params) { byActionRequests.push({ action, params }); return respond(action, params); }
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

const userGroupsFixture = {
    action: 'usergroups',
    ugroups: {
        'ugrp//operators': {
            name: 'operators',
            links: {
                'user//pilot': { rights: 0xFFFFFFFF },
                'user//viewer': { rights: 256 },
                'mesh//alpha': { rights: 2 }
            }
        }
    }
};

const loginTokensFixture = {
    action: 'loginTokens',
    loginTokens: [
        { name: 'ci token', tokenUser: '~t:abcdef', created: 1700000000000, expire: 0 }
    ]
};

const createLoginTokenFixture = {
    action: 'createLoginToken',
    name: 'ci token',
    tokenUser: '~t:abcdef',
    tokenPass: 'p4ssw0rd',
    created: 1700000000000,
    expire: 1700003600000
};

const reportFixture = {
    action: 'report',
    data: {
        groupFormat: 'user',
        columns: [{ id: 'time', title: 'time' }, { id: 'nodeid', title: 'device' }],
        groups: {
            'user//pilot': { entries: [{ time: 1700000000000, nodeid: NODE_ALPHA }] }
        }
    }
};

test('the admin family exposes one generated tool per catalogue entry', () => {
    const { server } = createServer({});
    const adminTools = catalogue.commands.filter((entry) => (entry.family === 'admin') && (entry.mcp != null));
    assert.deepEqual(adminTools.map((entry) => entry.mcp.name), ADMIN_TOOL_NAMES);

    for (const entry of adminTools) {
        const tool = server.registry.get(entry.mcp.name);
        assert.ok(tool != null, entry.mcp.name + ' is registered');
        const declared = (tool.inputSchema.shape != null) ? Object.keys(tool.inputSchema.shape) : Object.keys(tool.inputSchema);
        assert.deepEqual(declared, entry.args.map((arg) => arg.name), entry.name + ' argument names');
    }
});

test('required arguments are generated into the tool schema', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_remove_user', {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments for mesh_remove_user/);
    assert.match(result.content[0].text, /userid/);
    assert.deepEqual(client.requests, []);
});

test('mesh_add_user sends an adduser request with the account fields and rights', async () => {
    const { client, server, records } = createServer({ responses: { adduser: { action: 'adduser', result: 'ok' } } });

    const result = await server.registry.call('mesh_add_user', {
        user: 'alice',
        pass: 'hunter2',
        email: 'alice@example.test',
        emailverified: true,
        resetpass: true,
        realname: 'Alice Example',
        phone: '555-0100',
        rights: 'manageusers,fileaccess'
    });

    assert.deepEqual(client.requests, [{
        action: 'adduser',
        params: {
            username: 'alice',
            pass: 'hunter2',
            email: 'alice@example.test',
            emailVerified: true,
            resetNextLogin: true,
            siteadmin: (2 | 8),
            phone: '555-0100',
            realname: 'Alice Example'
        }
    }]);
    assert.equal(text(result), 'ok');
    assert.equal(records[0].tool, 'mesh_add_user');
    assert.equal(records[0].target, 'alice');
    assert.equal(records[0].outcome, 'ok');
});

test('mesh_add_user accepts meshctrl rights names and numeric rights', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_user', { user: 'alice', pass: 'x', rights: 'full' });
    await server.registry.call('mesh_add_user', { user: 'bob', pass: 'x', rights: '4294967295' });
    await server.registry.call('mesh_add_user', { user: 'carol', pass: 'x', rights: 'none' });

    assert.equal(client.requests[0].params.siteadmin, 0xFFFFFFFF);
    assert.equal(client.requests[1].params.siteadmin, 0xFFFFFFFF);
    assert.equal(client.requests[2].params.siteadmin, 0);
});

test('mesh_add_user generates a compliant random password when asked', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_user', { user: 'service', randompass: true });

    const params = client.requests[0].params;
    assert.equal(params.username, 'service');
    assert.equal(params.pass.length, 12);
    assert.match(params.pass, /[0-9]/);
    assert.match(params.pass, /[a-z]/);
    assert.match(params.pass, /[A-Z]/);
    assert.match(params.pass, /[^A-Za-z0-9]/);
});

test('mesh_add_user requires a supplied or random password, verbatim', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_add_user', { user: 'alice' });

    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'New account password missing, use --pass [password] or --randompass');
    assert.deepEqual(client.requests, []);
});

test('mesh_edit_user completes a bare userid with the domain and sends the changes', async () => {
    const { client, server } = createServer({ responses: { edituser: { action: 'edituser', result: 'ok' } } });

    await server.registry.call('mesh_edit_user', {
        userid: 'alice',
        domain: 'example',
        email: 'new@example.test',
        realname: '',
        rights: 'full',
        resetpass: true
    });

    assert.deepEqual(client.requests, [{
        action: 'edituser',
        params: {
            userid: 'user/example/alice',
            email: 'new@example.test',
            realname: '',
            resetNextLogin: true,
            siteadmin: 0xFFFFFFFF,
            domain: 'example'
        }
    }]);
});

test('mesh_remove_user sends a deleteuser request', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_remove_user', { userid: 'user//alice' });
    await server.registry.call('mesh_remove_user', { userid: 'bob', domain: 'example' });

    assert.deepEqual(client.requests, [
        { action: 'deleteuser', params: { userid: 'user//alice' } },
        { action: 'deleteuser', params: { userid: 'user/example/bob' } }
    ]);
});

test('mesh_login_tokens lists tokens with an action correlated request', async () => {
    const { client, server } = createServer({ responses: { loginTokens: loginTokensFixture } });

    const result = await server.registry.call('mesh_login_tokens', {});

    assert.deepEqual(client.requests, []);
    assert.deepEqual(client.byActionRequests, [{ action: 'loginTokens', params: {} }]);
    assert.equal(text(result), [
        'Name                        Username                    Expire',
        '-------------------------------------------------------------------------------------',
        'ci token' + ' '.repeat(20) + '~t:abcdef' + ' '.repeat(19) + 'Unlimited'
    ].join('\n'));
});

test('mesh_login_tokens creates a token and returns its one-time credentials', async () => {
    const { client, server } = createServer({ responses: { createLoginToken: createLoginTokenFixture } });

    const result = await server.registry.call('mesh_login_tokens', { add: 'ci token', expire: 60 });

    assert.deepEqual(client.requests, []);
    assert.deepEqual(client.byActionRequests, [{ action: 'createLoginToken', params: { name: 'ci token', expire: 60 } }]);
    assert.match(text(result), /^New login token created\./);
    assert.match(text(result), /Token name: ci token/);
    assert.match(text(result), /Username: ~t:abcdef/);
    assert.match(text(result), /Password: p4ssw0rd/);
});

test('mesh_login_tokens removes a token by user name', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_login_tokens', { remove: '~t:abcdef' });

    assert.deepEqual(client.byActionRequests, [{ action: 'loginTokens', params: { remove: ['~t:abcdef'] } }]);
});

test('mesh_login_tokens surfaces a server denial verbatim', async () => {
    const { server } = createServer({ responses: { createLoginToken: { action: 'createLoginToken', result: 'Access denied' } } });

    const result = await server.registry.call('mesh_login_tokens', { add: 'ci token' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied' }], isError: true });
});

test('mesh_add_user_group and mesh_remove_user_group mirror meshctrl', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_user_group', { name: 'operators', desc: 'Operators' });
    await server.registry.call('mesh_remove_user_group', { groupid: 'operators', domain: 'example' });

    assert.deepEqual(client.requests, [
        { action: 'createusergroup', params: { name: 'operators', desc: 'Operators' } },
        { action: 'deleteusergroup', params: { ugrpid: 'ugrp/example/operators' } }
    ]);
});

test('mesh_add_to_user_group adds a user, a device group or a device', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_to_user_group', { id: 'user//bob', groupid: 'ugrp//operators' });
    await server.registry.call('mesh_add_to_user_group', { id: MESH_ALPHA, groupid: 'ugrp//operators', rights: 0xFFFFFFFF });
    await server.registry.call('mesh_add_to_user_group', { id: NODE_ALPHA, groupid: 'ugrp//operators', rights: 8 });

    assert.deepEqual(client.requests, [
        { action: 'addusertousergroup', params: { ugrpid: 'ugrp//operators', usernames: ['bob'] } },
        { action: 'addmeshuser', params: { meshid: MESH_ALPHA, userid: 'ugrp//operators', meshadmin: 0xFFFFFFFF } },
        { action: 'adddeviceuser', params: { nodeid: NODE_ALPHA, userids: ['ugrp//operators'], rights: 8 } }
    ]);
});

test('mesh_add_to_user_group rejects an identifier without a known prefix', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_add_to_user_group', { id: 'bob', groupid: 'ugrp//operators' });

    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'The identifier must start with user/, mesh/ or node/.');
    assert.deepEqual(client.requests, []);
});

test('mesh_remove_from_user_group removes a user, a device group or a device', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_remove_from_user_group', { id: 'user//bob', groupid: 'ugrp//operators' });
    await server.registry.call('mesh_remove_from_user_group', { id: MESH_ALPHA, groupid: 'ugrp//operators' });
    await server.registry.call('mesh_remove_from_user_group', { id: NODE_ALPHA, groupid: 'ugrp//operators' });

    assert.deepEqual(client.requests, [
        { action: 'removeuserfromusergroup', params: { ugrpid: 'ugrp//operators', userid: 'user//bob' } },
        { action: 'removemeshuser', params: { meshid: MESH_ALPHA, userid: 'ugrp//operators' } },
        { action: 'adddeviceuser', params: { nodeid: NODE_ALPHA, userids: ['ugrp//operators'], rights: 0, remove: true } }
    ]);
});

test('mesh_remove_all_users_from_user_group lists the group then removes each user', async () => {
    const { client, server } = createServer({ responses: { usergroups: userGroupsFixture } });

    const result = await server.registry.call('mesh_remove_all_users_from_user_group', { groupid: 'ugrp//operators' });

    assert.deepEqual(client.byActionRequests, [{ action: 'usergroups', params: {} }]);
    assert.deepEqual(client.requests, [
        { action: 'removeuserfromusergroup', params: { ugrpid: 'ugrp//operators', userid: 'user//pilot' } },
        { action: 'removeuserfromusergroup', params: { ugrpid: 'ugrp//operators', userid: 'user//viewer' } }
    ]);
    assert.equal(text(result), 'Removing user//pilot\nRemoving user//viewer\nok');
});

test('mesh_remove_all_users_from_user_group reports an unknown group and an empty group', async () => {
    const { client, server } = createServer({
        responses: {
            usergroups: { action: 'usergroups', ugroups: { 'ugrp//empty': { name: 'empty', links: { [MESH_ALPHA]: { rights: 1 } } } } }
        }
    });

    const missing = await server.registry.call('mesh_remove_all_users_from_user_group', { groupid: 'ugrp//missing' });
    assert.equal(text(missing), 'User group not found.');

    const empty = await server.registry.call('mesh_remove_all_users_from_user_group', { groupid: 'ugrp//empty' });
    assert.equal(text(empty), 'No users in this user group.');
    assert.deepEqual(client.requests, []);
});

test('mesh_remove_all_users_from_user_group surfaces a removal denial verbatim', async () => {
    const { server } = createServer({
        responses: {
            usergroups: userGroupsFixture,
            removeuserfromusergroup: { action: 'removeuserfromusergroup', result: 'Access denied: missing usergroups right' }
        }
    });

    const result = await server.registry.call('mesh_remove_all_users_from_user_group', { groupid: 'ugrp//operators' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied: missing usergroups right' }], isError: true });
});

test('mesh_add_device_group mirrors the meshctrl createmesh request', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_device_group', { name: 'Lab' });
    await server.registry.call('mesh_add_device_group', {
        name: 'AMT Lab',
        desc: 'Intel AMT only',
        amtonly: true,
        features: 5,
        consent: 9
    });

    assert.deepEqual(client.requests, [
        { action: 'createmesh', params: { meshname: 'Lab', meshtype: 2 } },
        { action: 'createmesh', params: { meshname: 'AMT Lab', meshtype: 1, desc: 'Intel AMT only', flags: 5, consent: 9 } }
    ]);
});

test('mesh_add_device_group lets agentless override amtonly, as meshctrl does', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_device_group', { name: 'Agentless', amtonly: true, agentless: true });

    assert.equal(client.requests[0].params.meshtype, 3);
});

test('a mutation result carrying a meshid is printed the way meshctrl prints it', async () => {
    const { server } = createServer({ responses: { createmesh: { action: 'createmesh', result: 'ok', meshid: MESH_ALPHA } } });

    const result = await server.registry.call('mesh_add_device_group', { name: 'Lab' });

    assert.equal(text(result), 'ok ' + MESH_ALPHA);
});

test('mesh_remove_device_group names the group by id or by name', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_remove_device_group', { meshid: MESH_ALPHA });
    await server.registry.call('mesh_remove_device_group', { group: 'Lab' });

    assert.deepEqual(client.requests, [
        { action: 'deletemesh', params: { meshid: MESH_ALPHA } },
        { action: 'deletemesh', params: { meshname: 'Lab' } }
    ]);
});

test('mesh_remove_device_group requires an id or a name, verbatim', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_remove_device_group', {});

    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Device group identifier missing, use --id '[groupid]' or --group [groupname]");
    assert.deepEqual(client.requests, []);
});

test('mesh_edit_device_group sends names, flags, consent and invite codes', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_edit_device_group', {
        meshid: MESH_ALPHA,
        name: 'Renamed',
        desc: '',
        flags: 1,
        consent: 63,
        invitecodes: 'aa,bb',
        backgroundonly: true
    });
    await server.registry.call('mesh_edit_device_group', { group: 'Lab', invitecodes: 'cc', interactiveonly: true });

    assert.deepEqual(client.requests, [
        {
            action: 'editmesh',
            params: {
                meshid: MESH_ALPHA,
                meshname: 'Renamed',
                desc: '',
                flags: 1,
                consent: 63,
                invite: { codes: ['aa', 'bb'], flags: 2 }
            }
        },
        {
            action: 'editmesh',
            params: { meshidname: 'Lab', invite: { codes: ['cc'], flags: 1 } }
        }
    ]);
});

test('mesh_edit_device_group requires an id or a name, verbatim', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_edit_device_group', { name: 'Renamed' });

    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Device group identifier missing, use --id '[groupid]' or --group [groupname]");
    assert.deepEqual(client.requests, []);
});

test('mesh_add_user_to_device_group sums the per-group rights flags', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_user_to_device_group', { meshid: MESH_ALPHA, userid: 'user//bob', fullrights: true });
    await server.registry.call('mesh_add_user_to_device_group', {
        group: 'Lab',
        userid: 'user//bob',
        editgroup: true,
        manageusers: true,
        managedevices: true,
        remotecontrol: true,
        noamt: true,
        noregistry: true,
        nosoftware: true
    });

    assert.deepEqual(client.requests, [
        { action: 'addmeshuser', params: { meshid: MESH_ALPHA, userids: ['user//bob'], meshadmin: 0xFFFFFFFF } },
        { action: 'addmeshuser', params: { meshname: 'Lab', userids: ['user//bob'], meshadmin: ((1 | 2 | 4 | 8) + 2048 + 4194304 + 8388608) } }
    ]);
});

test('mesh_remove_user_from_device_group mirrors the removemeshuser request', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_remove_user_from_device_group', { meshid: MESH_ALPHA, userid: 'user//bob' });
    await server.registry.call('mesh_remove_user_from_device_group', { group: 'Lab', userid: 'user//bob' });

    assert.deepEqual(client.requests, [
        { action: 'removemeshuser', params: { meshid: MESH_ALPHA, userid: 'user//bob' } },
        { action: 'removemeshuser', params: { meshname: 'Lab', userid: 'user//bob' } }
    ]);
});

test('mesh_add_user_to_device sums the per-device rights flags', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_add_user_to_device', { id: NODE_ALPHA, userid: 'user//bob', fullrights: true });
    await server.registry.call('mesh_add_user_to_device', { id: NODE_ALPHA, userid: 'user//bob', remotecontrol: true, chatnotify: true });

    assert.deepEqual(client.requests, [
        { action: 'adddeviceuser', params: { nodeid: NODE_ALPHA, usernames: ['user//bob'], rights: (8 + 16 + 32 + 64 + 128 + 16384 + 32768) } },
        { action: 'adddeviceuser', params: { nodeid: NODE_ALPHA, usernames: ['user//bob'], rights: (8 | 16384) } }
    ]);
});

test('mesh_remove_user_from_device sends the remove request meshctrl sends', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_remove_user_from_device', { id: NODE_ALPHA, userid: 'user//bob' });

    assert.deepEqual(client.requests, [
        { action: 'adddeviceuser', params: { nodeid: NODE_ALPHA, usernames: ['user//bob'], rights: 0, remove: true } }
    ]);
});

test('mesh_report maps the report type and grouping and renders CSV', async () => {
    const { client, server } = createServer({ responses: { report: reportFixture } });

    const start = '2026-01-01T00:00:00Z';
    const end = '2026-01-02T00:00:00Z';
    const result = await server.registry.call('mesh_report', {
        type: 'traffic',
        start: start,
        end: end,
        groupby: 'device',
        devicegroup: MESH_ALPHA,
        showtraffic: true
    });

    assert.deepEqual(client.requests, []);
    assert.deepEqual(client.byActionRequests, [{
        action: 'report',
        params: {
            type: 2,
            groupBy: 2,
            devGroup: MESH_ALPHA,
            start: Math.floor(Date.parse(start) / 1000),
            end: Math.floor(Date.parse(end) / 1000),
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            tf: new Date().getTimezoneOffset(),
            showTraffic: true,
            l: 'en'
        }
    }]);
    assert.equal(text(result), 'group,time,nodeid\nuser//pilot,1700000000000,' + NODE_ALPHA);
});

test('mesh_report defaults the period to the last day, or the last week grouped by day', async () => {
    const { client, server } = createServer({ responses: { report: reportFixture } });

    const before = Math.round(new Date().getTime() / 1000);
    await server.registry.call('mesh_report', { type: 'sessions' });
    const after = Math.round(new Date().getTime() / 1000);
    const daily = client.byActionRequests[0].params;
    assert.equal(daily.type, 1);
    assert.equal(daily.groupBy, 1);
    assert.ok(daily.start >= (before - 24 * 3600) && daily.start <= (after - 24 * 3600), 'start is a day ago');
    assert.ok(daily.end >= before && daily.end <= after, 'end is now');

    await server.registry.call('mesh_report', { type: 'logins', groupby: 'day' });
    const weekly = client.byActionRequests[1].params;
    assert.equal(weekly.type, 3);
    assert.equal(weekly.groupBy, 3);
    assert.ok(weekly.start >= (before - 168 * 3600) && weekly.start <= (after - 168 * 3600), 'start is a week ago');
});

test('mesh_report keeps the meshctrl showtraffic flag semantics', async () => {
    const { client, server } = createServer({ responses: { report: reportFixture } });
    const period = { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' };

    await server.registry.call('mesh_report', Object.assign({ type: 'sessions', showtraffic: false }, period));
    await server.registry.call('mesh_report', Object.assign({ type: 'sessions' }, period));

    // meshctrl sends showTraffic true whenever the flag is present, even as
    // --no-showtraffic; the tool mirrors that.
    assert.equal(client.byActionRequests[0].params.showTraffic, true);
    assert.equal(client.byActionRequests[1].params.showTraffic, false);
});

test('mesh_report maps the database report and rejects an inverted period', async () => {
    const { client, server } = createServer({ responses: { report: reportFixture } });

    await server.registry.call('mesh_report', {
        type: 'db',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-02T00:00:00Z'
    });
    assert.equal(client.byActionRequests[0].params.type, 4);
    assert.equal(client.byActionRequests[0].params.devGroup, null);

    const result = await server.registry.call('mesh_report', {
        type: 'sessions',
        start: '2026-01-02T00:00:00Z',
        end: '2026-01-01T00:00:00Z'
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'End time must be ahead of start time.');
    assert.equal(client.byActionRequests.length, 1);
});

test('an action correlated transport failure is surfaced verbatim', async () => {
    const { server } = createServer({
        responses: { report: new TimeoutError('Command "report" timed out after 30ms.', 'ETIMEDOUT', 'report', 30) }
    });

    const result = await server.registry.call('mesh_report', {
        type: 'sessions',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-02T00:00:00Z'
    });

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'Command "report" timed out after 30ms.' }],
        isError: true
    });
});

test('a server denial on a destructive command is surfaced verbatim and audited', async () => {
    const { server, records } = createServer({
        responses: { deleteuser: { action: 'deleteuser', result: 'Access denied: missing manageusers right' } }
    });

    const result = await server.registry.call('mesh_remove_user', { userid: 'user//alice' });

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'Access denied: missing manageusers right' }],
        isError: true
    });
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Access denied: missing manageusers right');
    assert.equal(records[0].target, 'user//alice');
});

test('an MCP client can list the admin tools and call one over a transport', async (t) => {
    const { server } = createServer({ responses: { adduser: { action: 'adduser', result: 'ok' } } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();

    for (const name of ADMIN_TOOL_NAMES) {
        assert.ok(listed.tools.some((tool) => tool.name === name), name + ' is listed');
    }
    const addUser = listed.tools.find((tool) => tool.name === 'mesh_add_user');
    assert.deepEqual(addUser.inputSchema.required, ['user']);

    const result = await client.callTool({ name: 'mesh_add_user', arguments: { user: 'alice', pass: 'hunter2' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'ok');
});
