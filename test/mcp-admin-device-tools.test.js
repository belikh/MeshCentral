'use strict';

/**
 * Tests for the remaining administration and device-management tools generated
 * from the catalogue: agent invitations, local server configuration, device
 * moves, device deletion and editing, and local/Intel AMT device creation.
 *
 * Every test injects a fake MeshCentral client into the server factory: no
 * live server, no real tokens, node ids or domains. The fake records the exact
 * action and params of every request so the protocol mapping is pinned against
 * the messages meshctrl sends for the same command. The config tool is local,
 * so it is exercised against a temporary config.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createMcpServer } = require('../mcp-server.js');
const catalogue = require('../command-catalogue.js');

const MESH_ALPHA = 'mesh//MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx';
const MESH_BRAVO = 'mesh//MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy';
const NODE_ALPHA = 'node//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NODE_BRAVO = 'node//BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const REMAINING_TOOLS = [
    'mesh_send_invite_email',
    'mesh_generate_invite_link',
    'mesh_config',
    'mesh_move_to_device_group',
    'mesh_remove_device',
    'mesh_edit_device',
    'mesh_add_local_device',
    'mesh_add_amt_device'
];

function createFakeClient(state) {
    state = state || {};
    const requests = [];
    const responses = state.responses || {};
    return {
        requests,
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

/** Run one test against a temporary config.json, in its own working directory. */
function useTempConfig(t, config) {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-config-'));
    t.after(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
    if (config != null) { fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2)); }
    process.chdir(dir);
    return dir;
}

test('the remaining family exposes one generated tool per catalogue entry', () => {
    const { server } = createServer({});
    const entries = ['sendinviteemail', 'generateinvitelink', 'config', 'movetodevicegroup', 'removedevice', 'editdevice', 'addlocaldevice', 'addamtdevice']
        .map((name) => catalogue.byName(name));
    assert.deepEqual(entries.map((entry) => entry.mcp.name), REMAINING_TOOLS);

    for (const entry of entries) {
        const tool = server.registry.get(entry.mcp.name);
        assert.ok(tool != null, entry.mcp.name + ' is registered');
        const declared = (tool.inputSchema.shape != null) ? Object.keys(tool.inputSchema.shape) : Object.keys(tool.inputSchema);
        assert.deepEqual(declared, entry.args.map((arg) => arg.name), entry.name + ' argument names');
    }
});

test('upload and download stay deliberate omissions with their catalogue order intact', () => {
    assert.equal(catalogue.byName('upload').mcp, null);
    assert.equal(catalogue.byName('download').mcp, null);
    assert.equal(catalogue.byName('upload').protocol, null);
    assert.equal(catalogue.byName('download').protocol, null);
    assert.equal(catalogue.byName('upload').omitted, true);
    assert.equal(catalogue.byName('download').omitted, true);

    const names = catalogue.commandNames();
    assert.deepEqual(names.slice(names.indexOf('shell'), names.indexOf('deviceopenurl') + 1), ['shell', 'upload', 'download', 'deviceopenurl']);
});

test('mesh_send_invite_email sends the inviteAgent request meshctrl sends', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_send_invite_email', {
        meshid: MESH_ALPHA,
        email: 'operator@example.test',
        name: 'Operator',
        message: 'Please install the agent.'
    });

    assert.deepEqual(client.requests, [{
        action: 'inviteAgent',
        params: { email: 'operator@example.test', name: 'Operator', os: '0', meshid: MESH_ALPHA, msg: 'Please install the agent.' }
    }]);
    assert.equal(text(result), 'ok');
});

test('mesh_send_invite_email names the group by name and keeps the CLI defaults', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_send_invite_email', { group: 'Lab', email: 'operator@example.test' });

    assert.deepEqual(client.requests[0].params, { email: 'operator@example.test', name: '', os: '0', meshname: 'Lab' });
});

test('mesh_send_invite_email requires a group, verbatim, and an email in the schema', async () => {
    const { client, server } = createServer({});

    const missingGroup = await server.registry.call('mesh_send_invite_email', { email: 'operator@example.test' });
    assert.equal(missingGroup.isError, true);
    assert.equal(missingGroup.content[0].text, "Device group identifier missing, use --id '[groupid]' or --group [groupname]");

    const missingEmail = await server.registry.call('mesh_send_invite_email', { meshid: MESH_ALPHA });
    assert.equal(missingEmail.isError, true);
    assert.match(missingEmail.content[0].text, /Invalid arguments for mesh_send_invite_email/);
    assert.match(missingEmail.content[0].text, /email/);

    assert.deepEqual(client.requests, []);
});

test('mesh_send_invite_email surfaces a server denial verbatim', async () => {
    const { server } = createServer({ responses: { inviteAgent: { action: 'inviteAgent', result: 'Unsupported feature' } } });

    const result = await server.registry.call('mesh_send_invite_email', { meshid: MESH_ALPHA, email: 'operator@example.test' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Unsupported feature' }], isError: true });
});

test('mesh_generate_invite_link sends the createInviteLink request and returns its URL', async () => {
    const { client, server } = createServer({
        responses: { createInviteLink: { action: 'createInviteLink', result: 'ok', url: 'https://mc.example.test/agentinvite?c=sanitised' } }
    });

    const result = await server.registry.call('mesh_generate_invite_link', { meshid: MESH_ALPHA, hours: 24 });

    assert.deepEqual(client.requests, [{
        action: 'createInviteLink',
        params: { expire: 24, flags: 0, meshid: MESH_ALPHA }
    }]);
    assert.equal(text(result), 'https://mc.example.test/agentinvite?c=sanitised');
});

test('mesh_generate_invite_link maps the group name, an infinite link and the flags', async () => {
    const { client, server } = createServer({
        responses: { createInviteLink: { action: 'createInviteLink', result: 'ok', url: 'https://mc.example.test/agentinvite?c=sanitised' } }
    });

    await server.registry.call('mesh_generate_invite_link', { group: 'Lab', hours: 0, flags: 2 });

    assert.deepEqual(client.requests[0].params, { expire: 0, flags: 2, meshname: 'Lab' });
});

test('mesh_generate_invite_link requires a group, verbatim, and fails without a URL', async () => {
    const { client, server } = createServer({ responses: { createInviteLink: { action: 'createInviteLink', result: 'ok' } } });

    const missingGroup = await server.registry.call('mesh_generate_invite_link', { hours: 24 });
    assert.equal(missingGroup.isError, true);
    assert.equal(missingGroup.content[0].text, "Device group identifier missing, use --id '[groupid]' or --group [groupname]");

    const missingHours = await server.registry.call('mesh_generate_invite_link', { meshid: MESH_ALPHA });
    assert.equal(missingHours.isError, true);
    assert.match(missingHours.content[0].text, /Invalid arguments for mesh_generate_invite_link/);
    assert.deepEqual(client.requests, []);

    const noUrl = await server.registry.call('mesh_generate_invite_link', { meshid: MESH_ALPHA, hours: 24 });
    assert.equal(text(noUrl), 'ok');
    assert.equal(client.requests.length, 1);
});

test('mesh_generate_invite_link surfaces a server denial verbatim', async () => {
    const { server } = createServer({ responses: { createInviteLink: { action: 'createInviteLink', result: 'Invalid group id' } } });

    const result = await server.registry.call('mesh_generate_invite_link', { meshid: MESH_ALPHA, hours: 24 });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Invalid group id' }], isError: true });
});

const configFixture = {
    settings: { cert: 'sanitised' },
    domains: {
        '': { title: 'Default domain' },
        '_internal': { title: 'Internal' },
        'example': { title: 'Example domain' }
    }
};

test('mesh_config show returns the local config.json as JSON', async (t) => {
    useTempConfig(t, configFixture);
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_config', { show: true });

    assert.equal(text(result), JSON.stringify(configFixture, null, 2));
    assert.deepEqual(client.requests, []);
});

test('mesh_config listdomains skips the default and internal domains', async (t) => {
    useTempConfig(t, configFixture);
    const { server } = createServer({});

    const result = await server.registry.call('mesh_config', { listdomains: true });

    assert.equal(text(result), 'example');
});

test('mesh_config listdomains reports a config without domains', async (t) => {
    useTempConfig(t, { settings: {} });
    const { server } = createServer({});

    const result = await server.registry.call('mesh_config', { listdomains: true });

    assert.equal(text(result), 'No domains found.');
});

test('mesh_config adddomain and removedomain edit the local file', async (t) => {
    const dir = useTempConfig(t, configFixture);
    const { server } = createServer({});

    const added = await server.registry.call('mesh_config', { adddomain: 'lab' });
    assert.equal(text(added), 'Done.');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).domains.lab, {});

    const removed = await server.registry.call('mesh_config', { removedomain: 'lab' });
    assert.equal(text(removed), 'Done.');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).domains.lab, undefined);
});

test('mesh_config keeps the CLI messages for unknown and existing domains', async (t) => {
    useTempConfig(t, configFixture);
    const { server } = createServer({});

    const existing = await server.registry.call('mesh_config', { adddomain: 'example' });
    assert.equal(text(existing), 'Error: Domain "example" already exists\nDone.');

    const missing = await server.registry.call('mesh_config', { removedomain: 'missing' });
    assert.equal(text(missing), 'Error: Domain "missing" does not exist\nDone.');

    const unchanged = await server.registry.call('mesh_config', { settodomain: 'example' });
    assert.equal(text(unchanged), 'Done.');
});

test('mesh_config without an operation shows the CLI help, and an absent file is an error', async (t) => {
    const dir = useTempConfig(t, null);
    const { server } = createServer({});

    const missing = await server.registry.call('mesh_config', {});
    assert.equal(missing.isError, true);
    assert.equal(missing.content[0].text, 'Unable to find config.json.');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configFixture, null, 2));
    const help = await server.registry.call('mesh_config', {});
    assert.match(text(help), /MeshCtrl config --show/);
    assert.match(text(help), /--settodomain \[domain\]/);
});

test('mesh_move_to_device_group sends the changeDeviceMesh request meshctrl sends', async () => {
    const { client, server } = createServer({});

    const result = await server.registry.call('mesh_move_to_device_group', { meshid: MESH_ALPHA, devid: NODE_ALPHA });

    assert.deepEqual(client.requests, [{
        action: 'changeDeviceMesh',
        params: { nodeids: [NODE_ALPHA], meshid: MESH_ALPHA }
    }]);
    assert.equal(text(result), 'ok');
});

test('mesh_move_to_device_group names the target group by name and validates the arguments', async () => {
    const { client, server } = createServer({});

    await server.registry.call('mesh_move_to_device_group', { group: 'Lab', devid: NODE_BRAVO });
    assert.deepEqual(client.requests, [{ action: 'changeDeviceMesh', params: { nodeids: [NODE_BRAVO], meshname: 'Lab' } }]);

    const missingGroup = await server.registry.call('mesh_move_to_device_group', { devid: NODE_ALPHA });
    assert.equal(missingGroup.isError, true);
    assert.equal(missingGroup.content[0].text, "Device group identifier missing, use --id '[groupid]' or --group [groupname]");

    const missingDevice = await server.registry.call('mesh_move_to_device_group', { meshid: MESH_ALPHA });
    assert.equal(missingDevice.isError, true);
    assert.match(missingDevice.content[0].text, /Invalid arguments for mesh_move_to_device_group/);

    assert.equal(client.requests.length, 1);
});

test('mesh_move_to_device_group surfaces a permission denial verbatim', async () => {
    const { server } = createServer({ responses: { changeDeviceMesh: { action: 'changeDeviceMesh', result: 'Permission denied' } } });

    const result = await server.registry.call('mesh_move_to_device_group', { meshid: MESH_ALPHA, devid: NODE_ALPHA });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Permission denied' }], isError: true });
});

test('mesh_remove_device sends the removedevices request and audits its target', async () => {
    const { client, server, records } = createServer({ responses: { removedevices: { action: 'removedevices', result: 'ok' } } });

    const result = await server.registry.call('mesh_remove_device', { id: NODE_ALPHA });

    assert.deepEqual(client.requests, [{ action: 'removedevices', params: { nodeids: [NODE_ALPHA] } }]);
    assert.equal(text(result), 'ok');
    assert.equal(records[0].tool, 'mesh_remove_device');
    assert.equal(records[0].target, NODE_ALPHA);
    assert.equal(records[0].outcome, 'ok');
});

test('mesh_remove_device requires a device id and surfaces a denial verbatim', async () => {
    const { client, server, records } = createServer({ responses: { removedevices: { action: 'removedevices', result: 'Denied' } } });

    const missing = await server.registry.call('mesh_remove_device', {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Invalid arguments for mesh_remove_device/);
    assert.equal(client.requests.length, 0);

    const denied = await server.registry.call('mesh_remove_device', { id: NODE_ALPHA });
    assert.deepEqual(denied, { content: [{ type: 'text', text: 'Denied' }], isError: true });
    assert.equal(records[1].target, NODE_ALPHA);
    assert.equal(records[1].outcome, 'error');
    assert.equal(records[1].reason, 'Denied');
});

test('mesh_edit_device sends a changedevice request with the changed fields', async () => {
    const { client, server } = createServer({ responses: { changedevice: { action: 'changedevice', result: 'ok' } } });

    const result = await server.registry.call('mesh_edit_device', {
        id: NODE_ALPHA,
        name: 'renamed-host',
        desc: 'lab machine',
        tags: 'alpha,beta',
        icon: 3,
        consent: 1
    });

    assert.deepEqual(client.requests, [{
        action: 'changedevice',
        params: { nodeid: NODE_ALPHA, name: 'renamed-host', desc: 'lab machine', tags: ['alpha', 'beta'], icon: 3, consent: 1 }
    }]);
    assert.equal(text(result), 'ok');
});

test('mesh_edit_device reads the device before adding and removing tags', async () => {
    const nodes = {
        action: 'nodes',
        nodes: { [MESH_ALPHA]: [{ _id: NODE_ALPHA, name: 'host-alpha', tags: ['old', 'keep'] }] }
    };
    const { client, server } = createServer({ responses: { nodes: nodes, changedevice: { action: 'changedevice', result: 'ok' } } });

    const result = await server.registry.call('mesh_edit_device', { id: NODE_ALPHA, addtag: 'new, old2 ', removetag: 'old' });

    assert.deepEqual(client.requests, [
        { action: 'nodes', params: { id: NODE_ALPHA } },
        { action: 'changedevice', params: { nodeid: NODE_ALPHA, tags: ['keep', 'new', 'old2'] } }
    ]);
    assert.equal(text(result), 'ok');
});

test('mesh_edit_device reports a node missing from the tag lookup', async () => {
    const nodes = { action: 'nodes', nodes: { [MESH_ALPHA]: [{ _id: NODE_BRAVO, name: 'host-beta', tags: [] }] } };
    const { client, server } = createServer({ responses: { nodes: nodes, changedevice: { action: 'changedevice', result: 'ok' } } });

    const result = await server.registry.call('mesh_edit_device', { id: NODE_ALPHA, addtag: 'new' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Node not found.' }], isError: true });
    assert.deepEqual(client.requests, [{ action: 'nodes', params: { id: NODE_ALPHA } }]);
});

test('mesh_edit_device keeps the CLI icon and consent validation, verbatim', async () => {
    const { client, server } = createServer({});

    const icon = await server.registry.call('mesh_edit_device', { id: NODE_ALPHA, icon: 9 });
    assert.equal(icon.isError, true);
    assert.equal(icon.content[0].text, 'Icon must be between 1 and 8.');

    const consent = await server.registry.call('mesh_edit_device', { id: NODE_ALPHA, consent: -1 });
    assert.equal(consent.isError, true);
    assert.equal(consent.content[0].text, 'Invalid consent flags.');

    assert.deepEqual(client.requests, []);
});

test('mesh_edit_device surfaces a server denial verbatim and audits its target', async () => {
    const { server, records } = createServer({ responses: { changedevice: { action: 'changedevice', result: 'Access Denied' } } });

    const result = await server.registry.call('mesh_edit_device', { id: NODE_ALPHA, name: 'renamed-host' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access Denied' }], isError: true });
    assert.equal(records[0].tool, 'mesh_edit_device');
    assert.equal(records[0].target, NODE_ALPHA);
    assert.equal(records[0].outcome, 'error');
});

test('mesh_add_local_device sends the addlocaldevice request with the CLI type default', async () => {
    const { client, server } = createServer({ responses: { addlocaldevice: { action: 'addlocaldevice', result: 'ok' } } });

    const result = await server.registry.call('mesh_add_local_device', {
        meshid: MESH_ALPHA,
        devicename: 'printer-1',
        hostname: 'printer-1.example.test'
    });

    assert.deepEqual(client.requests, [{
        action: 'addlocaldevice',
        params: { type: 4, meshid: MESH_ALPHA, devicename: 'printer-1', hostname: 'printer-1.example.test' }
    }]);
    assert.equal(text(result), 'ok');
});

test('mesh_add_local_device forwards an explicit device type and validates its arguments', async () => {
    const { client, server } = createServer({ responses: { addlocaldevice: { action: 'addlocaldevice', result: 'ok' } } });

    await server.registry.call('mesh_add_local_device', { meshid: MESH_ALPHA, devicename: 'nas-1', hostname: 'nas-1.example.test', type: 6 });
    assert.equal(client.requests[0].params.type, 6);

    const missingHost = await server.registry.call('mesh_add_local_device', { meshid: MESH_ALPHA, devicename: 'nas-1' });
    assert.equal(missingHost.isError, true);
    assert.match(missingHost.content[0].text, /Invalid arguments for mesh_add_local_device/);
    assert.match(missingHost.content[0].text, /hostname/);

    assert.equal(client.requests.length, 1);
});

test('mesh_add_local_device surfaces a denial verbatim and audits its target', async () => {
    const { server, records } = createServer({ responses: { addlocaldevice: { action: 'addlocaldevice', result: 'Local device agentless mesh only allowed' } } });

    const result = await server.registry.call('mesh_add_local_device', {
        meshid: MESH_ALPHA,
        devicename: 'printer-1',
        hostname: 'printer-1.example.test'
    });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Local device agentless mesh only allowed' }], isError: true });
    assert.equal(records[0].target, MESH_ALPHA);
    assert.equal(records[0].outcome, 'error');
});

test('mesh_add_amt_device sends the addamtdevice request with TLS on by default', async () => {
    const { client, server } = createServer({ responses: { addamtdevice: { action: 'addamtdevice', result: 'ok' } } });

    const result = await server.registry.call('mesh_add_amt_device', {
        meshid: MESH_ALPHA,
        devicename: 'amt-1',
        hostname: 'amt-1.example.test',
        user: 'admin',
        pass: 'sanitised'
    });

    assert.deepEqual(client.requests, [{
        action: 'addamtdevice',
        params: {
            amttls: 1,
            meshid: MESH_ALPHA,
            devicename: 'amt-1',
            hostname: 'amt-1.example.test',
            amtusername: 'admin',
            amtpassword: 'sanitised'
        }
    }]);
    assert.equal(text(result), 'ok');
});

test('mesh_add_amt_device turns TLS off with notls and surfaces a denial verbatim', async () => {
    const { client, server } = createServer({ responses: { addamtdevice: { action: 'addamtdevice', result: 'Intel AMT agentless mesh only allowed' } } });

    const result = await server.registry.call('mesh_add_amt_device', {
        meshid: MESH_BRAVO,
        devicename: 'amt-2',
        hostname: 'amt-2.example.test',
        user: 'admin',
        pass: 'sanitised',
        notls: true
    });

    assert.equal(client.requests[0].params.amttls, 0);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'Intel AMT agentless mesh only allowed' }], isError: true });

    const missingPassword = await server.registry.call('mesh_add_amt_device', { meshid: MESH_ALPHA, devicename: 'amt-3', hostname: 'amt-3.example.test', user: 'admin' });
    assert.equal(missingPassword.isError, true);
    assert.match(missingPassword.content[0].text, /Invalid arguments for mesh_add_amt_device/);
    assert.match(missingPassword.content[0].text, /pass/);
});

test('an MCP client can list the remaining tools and call one over a transport', async (t) => {
    const { server } = createServer({ responses: { removedevices: { action: 'removedevices', result: 'ok' } } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    t.after(async () => { await client.close(); await server.close(); await clientTransport.close(); });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();

    for (const name of REMAINING_TOOLS) {
        assert.ok(listed.tools.some((tool) => tool.name === name), name + ' is listed');
    }
    const removeDevice = listed.tools.find((tool) => tool.name === 'mesh_remove_device');
    assert.deepEqual(removeDevice.inputSchema.required, ['id']);

    const result = await client.callTool({ name: 'mesh_remove_device', arguments: { id: NODE_ALPHA } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'ok');
});
