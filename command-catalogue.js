'use strict';

/**
 * @description The MeshCentral command catalogue: one declarative entry per
 * command of the meshctrl CLI.
 *
 * The catalogue is the single source of truth shared by the CLI and the MCP
 * bridge. meshctrl.js renders its command list from it, and mcp-tools.js
 * generates its tool schemas and protocol calls from it, so the two cannot
 * drift apart. Later tickets extend the same entries with the device action
 * and administrative command families.
 *
 * This module has no dependencies and no side effects: it parses nothing,
 * prints nothing and never exits, so the CLI and tests can require it safely.
 *
 * Entry shape:
 *   name         Canonical command name; also the meshctrl command name.
 *   description  Human and agent readable summary.
 *   family       'inspection' | 'device' | 'admin' | 'local'. A grouping for
 *                later tickets; it carries no behaviour.
 *   args         Declared arguments: { name, type, required, description }
 *                where type is 'string' | 'number' | 'boolean'. An optional
 *                'cli' names the meshctrl flag when it differs from name.
 *                The MCP tool schema and its validation are generated from
 *                this list; nothing per tool is hand written.
 *   auth         Descriptive rights metadata: { user: true, rights: [...] }
 *                where rights lists the server permission names an account
 *                typically needs. It documents, it does not enforce: the
 *                server remains the only authority. Null when undeclared.
 *   cli          { name } mapping onto the meshctrl command.
 *   mcp          { name } tool name in the MCP bridge, or null when the
 *                command has no tool surface yet.
 *   protocol     How to execute through the client. One of:
 *                  { action, params?(args) }   a single request
 *                  [ { action, params?(args), optional? }, ... ]  several
 *                                              requests, in order
 *                  { from: 'serverInfo' }      a value captured during the
 *                                              connection handshake
 *                An 'optional' request may fail without failing the command.
 *   format       (value, args) => string. value is the response (single
 *                request), the ordered response array (several requests), or
 *                the handshake value (from). Returns the tool text.
 *   target       (args) => string used for the audit record, or null.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

/** Replace quotes and line breaks so one field stays on one text line. */
function escapeField(value) {
    return String((value != null) ? value : '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

/** The last path segment of a MeshCentral identifier, e.g. mesh//abc -> abc. */
function shortId(id) {
    const parts = String(id).split('/');
    return (parts.length > 2) ? parts[2] : String(id);
}

/** Render one CSV row the way meshctrl does: quote, strip embedded quotes. */
function csvRow(values) {
    return values.map((value) => (((value == null) || (value === '')) ? '' : ('"' + String(value).split('"').join('') + '"'))).join(',');
}

/** Flatten the mesh-keyed nodes map of a nodes response into device records. */
function flattenNodes(nodes) {
    const devices = [];
    if ((nodes == null) || (typeof nodes !== 'object')) { return devices; }
    for (const meshid of Object.keys(nodes)) {
        const group = nodes[meshid];
        if (!Array.isArray(group)) { continue; }
        for (const node of group) {
            devices.push({
                id: node._id,
                name: node.name,
                group: meshid,
                connected: node.conn ? node.conn : 0,
                power: node.pwr ? node.pwr : 0
            });
        }
    }
    return devices;
}

/** Render devices as the tabular text returned to the agent. */
function formatDeviceList(devices) {
    if ((devices == null) || (devices.length === 0)) { return 'No devices found.'; }
    const lines = ['id, name, group, connected, power'];
    for (const device of devices) {
        lines.push('"' + escapeField(device.id) + '", "' + escapeField(device.name) + '", "' + escapeField(device.group) + '", ' + device.connected + ', ' + device.power);
    }
    return lines.join('\n');
}

/** Render a mesh id whole (default) or as meshctrl's 0x hex segment. */
function formatMeshId(id, hex) {
    if (hex !== true) { return String(id); }
    const mid = shortId(id);
    return '0x' + Buffer.from(mid.replace(/@/g, '+').replace(/\$/g, '/'), 'base64').toString('hex').toUpperCase();
}

/** The device group rights names meshctrl prints, in its order. */
function meshRightsNames(rights) {
    if (rights === 0xFFFFFFFF) { return ['FullAdministrator']; }
    const names = [];
    if (rights & 1) { names.push('EditMesh'); }
    if (rights & 2) { names.push('ManageUsers'); }
    if (rights & 4) { names.push('ManageComputers'); }
    if (rights & 8) { names.push('RemoteControl'); }
    if (rights & 16) { names.push('AgentConsole'); }
    if (rights & 32) { names.push('ServerFiles'); }
    if (rights & 64) { names.push('WakeDevice'); }
    if (rights & 128) { names.push('SetNotes'); }
    if (rights & 256) { names.push('RemoteViewOnly'); }
    if (rights & 512) { names.push('NoTerminal'); }
    if (rights & 1024) { names.push('NoFiles'); }
    if (rights & 2048) { names.push('NoAMT'); }
    if (rights & 4096) { names.push('DesktopLimitedInput'); }
    return names;
}

function formatDeviceGroups(response, args) {
    const meshes = Array.isArray(response.meshes) ? response.meshes : [];
    if (args.idexists != null) {
        for (const mesh of meshes) {
            if ((mesh._id === args.idexists) || (shortId(mesh._id) === args.idexists)) { return '1'; }
        }
        return '0';
    }
    if (args.nameexists != null) {
        for (const mesh of meshes) {
            if (mesh.name === args.nameexists) { return mesh._id; }
        }
        return '';
    }
    if (meshes.length === 0) { return 'No device groups found.'; }
    const lines = ['id, name'];
    for (const mesh of meshes) {
        lines.push('"' + escapeField(formatMeshId(mesh._id, args.hex)) + '", "' + escapeField(mesh.name) + '"');
    }
    return lines.join('\n');
}

function formatDevices(response, args) {
    let devices = flattenNodes(response.nodes);
    if (args.filter != null) {
        const needle = String(args.filter).toLowerCase();
        devices = devices.filter((device) =>
            String(device.id).toLowerCase().includes(needle) || String(device.name).toLowerCase().includes(needle));
    }
    if (args.count === true) { return String(devices.length); }
    return formatDeviceList(devices);
}

function formatDeviceInfo(responses, args) {
    const nodesResponse = responses[0] || null;
    const network = responses[1] || null;
    const lastConnect = responses[2] || null;
    const sysinfo = responses[3] || null;

    let node = ((sysinfo != null) && (sysinfo.node != null)) ? sysinfo.node : null;
    if ((node == null) && (nodesResponse != null) && (nodesResponse.nodes != null)) {
        for (const meshid of Object.keys(nodesResponse.nodes)) {
            for (const candidate of nodesResponse.nodes[meshid]) {
                if (String(candidate._id).indexOf(args.id) >= 0) { node = candidate; break; }
            }
            if (node != null) { break; }
        }
    }
    if (node == null) { return 'Invalid device id'; }

    const info = { node: node };
    if (lastConnect != null) { info.lastConnect = lastConnect; }
    if (sysinfo != null) { info.system = sysinfo; }
    if (network != null) { info.network = network; }
    return JSON.stringify(info, null, 2);
}

function formatUsers(response, args) {
    let users = Array.isArray(response.users) ? response.users : [];
    if (args.filter != null) {
        const filters = String(args.filter).toLowerCase().split(',');
        users = users.filter((user) => {
            const twoFactor = (user.otphkeys != null) || (user.otpkeys != null) || (user.otpsecret != null);
            if ((filters.indexOf('2fa') >= 0) && twoFactor) { return true; }
            if ((filters.indexOf('no2fa') >= 0) && (twoFactor === false)) { return true; }
            return false;
        });
    }
    if (args.idexists != null) {
        for (const user of users) {
            if ((user._id === args.idexists) || (shortId(user._id) === args.idexists)) { return '1'; }
        }
        return '0';
    }
    if (args.nameexists != null) {
        for (const user of users) {
            if (user.name === args.nameexists) { return user._id; }
        }
        return '';
    }
    if (users.length === 0) { return 'No users found.'; }
    const lines = ['id, name, email'];
    for (const user of users) {
        let line = '"' + escapeField(shortId(user._id)) + '", "' + escapeField(user.name) + '"';
        if (user.email != null) { line += ', "' + escapeField(user.email) + '"'; }
        lines.push(line);
    }
    return lines.join('\n');
}

function formatUserGroups(response) {
    return JSON.stringify((response.ugroups != null) ? response.ugroups : {}, null, 2);
}

function formatDeviceGroupUsers(response, args) {
    const meshes = Array.isArray(response.meshes) ? response.meshes : [];
    let mesh = null;
    for (const candidate of meshes) {
        if ((candidate._id === args.id) || (shortId(candidate._id) === args.id)) { mesh = candidate; break; }
    }
    if (mesh == null) { return 'Group id not found'; }
    const links = (mesh.links != null) ? mesh.links : {};
    const ids = Object.keys(links);
    if (ids.length === 0) { return 'No users in this device group.'; }
    const lines = ['userid, rights'];
    for (const id of ids) {
        lines.push(shortId(id) + ', ' + meshRightsNames(links[id].rights).join(', '));
    }
    return lines.join('\n');
}

function formatEvents(response, args) {
    const events = Array.isArray(response.events) ? response.events : [];
    const lines = [];
    if (args.id != null) {
        lines.push('time,type,action,userid,msg');
        for (const event of events) { lines.push(csvRow([event.time, event.etype, event.action, event.userid, event.msg])); }
    } else if (args.userid != null) {
        lines.push('time,type,action,nodeid,msg');
        for (const event of events) { lines.push(csvRow([event.time, event.etype, event.action, event.nodeid, event.msg])); }
    } else {
        lines.push('time,type,action,nodeid,userid,msg');
        for (const event of events) { lines.push(csvRow([event.time, event.etype, event.action, event.nodeid, event.userid, event.msg])); }
    }
    return lines.join('\n');
}

function formatServerVersion(response) {
    const tags = (response.tags != null) ? response.tags : {};
    let text = 'MeshCentral version: ' + ((tags.current != null) ? tags.current : 'unknown');
    if (typeof tags.latest === 'string') { text += ' (latest: ' + tags.latest + ')'; }
    if (typeof tags.stable === 'string') { text += ' (stable: ' + tags.stable + ')'; }
    return text;
}

function formatJson(value) {
    return JSON.stringify(value, null, 2);
}

/** A command declared but not yet extended with a protocol mapping or tool. */
function pending(name, description, family) {
    return {
        name: name,
        description: description,
        family: family,
        args: [],
        auth: null,
        cli: { name: name },
        mcp: null,
        protocol: null,
        format: null,
        target: null
    };
}

const commands = [
    {
        name: 'edituser',
        description: 'Change an existing user account: email, real name, phone, account rights and password reset. Requires account administration rights on the server.',
        family: 'admin',
        args: [],
        auth: null,
        cli: { name: 'edituser' },
        mcp: null,
        protocol: null,
        format: null,
        target: null
    },
    {
        name: 'listusers',
        description: 'List user accounts visible to the authenticated account, one per line with account id, name and email. Optionally restrict to accounts with or without two-factor authentication, or test for an account id or name.',
        family: 'inspection',
        args: [
            { name: 'filter', type: 'string', required: false, description: 'Comma separated filter list: "2fa" selects accounts with two-factor authentication, "no2fa" selects accounts without.' },
            { name: 'idexists', type: 'string', required: false, description: 'Return 1 when this user id exists, 0 when it does not.' },
            { name: 'nameexists', type: 'string', required: false, description: 'Return the user id for this user name, or an empty result when the name is unknown.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: { name: 'listusers' },
        mcp: { name: 'mesh_list_users' },
        protocol: { action: 'users', params: () => ({}) },
        format: formatUsers,
        target: (args) => ((args.filter != null) ? args.filter : 'all')
    },
    pending('listusersessions', 'List the number of active web sessions for each online user account.', 'inspection'),
    {
        name: 'listdevicegroups',
        description: 'List device groups visible to the authenticated account, one per line with group id and name. Optionally test whether a group id or name exists, or render ids in hex.',
        family: 'inspection',
        args: [
            { name: 'idexists', type: 'string', required: false, description: 'Return 1 when this device group id exists, 0 when it does not.' },
            { name: 'nameexists', type: 'string', required: false, description: 'Return the device group id for this group name, or an empty result when the name is unknown.' },
            { name: 'hex', type: 'boolean', required: false, description: 'Render group ids as 0x hex instead of base64.' }
        ],
        auth: { user: true, rights: [] },
        cli: { name: 'listdevicegroups' },
        mcp: { name: 'mesh_list_groups' },
        protocol: { action: 'meshes', params: () => ({}) },
        format: formatDeviceGroups,
        target: (args) => ((args.idexists != null) ? args.idexists : ((args.nameexists != null) ? args.nameexists : 'all'))
    },
    {
        name: 'listdevices',
        description: 'List devices visible to the authenticated account, one per line with device id, name, device group, connection and power state. Optionally restrict to a device group by id or name, narrow the result with a case-insensitive filter on device name or id, or return only the device count.',
        family: 'inspection',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Restrict the listing to this device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Restrict the listing to this device group name.' },
            { name: 'filter', type: 'string', required: false, description: 'Case-insensitive substring match on device name or device id.' },
            { name: 'count', type: 'boolean', required: false, description: 'Return only the number of matching devices.' }
        ],
        auth: { user: true, rights: [] },
        cli: { name: 'listdevices' },
        mcp: { name: 'mesh_list_devices' },
        protocol: {
            action: 'nodes',
            params: (args) => {
                if (args.group != null) { return { meshname: args.group }; }
                if (args.meshid != null) { return { meshid: args.meshid }; }
                return {};
            }
        },
        format: formatDevices,
        target: (args) => ((args.meshid != null) ? args.meshid : ((args.group != null) ? args.group : ((args.filter != null) ? args.filter : 'all')))
    },
    {
        name: 'listusersofdevicegroup',
        description: 'List the users that have permissions on a device group, with their per-group rights.',
        family: 'inspection',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device group id (mesh//...) or its base64 id segment.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: { name: 'listusersofdevicegroup' },
        mcp: { name: 'mesh_list_device_group_users' },
        protocol: { action: 'meshes', params: () => ({}) },
        format: formatDeviceGroupUsers,
        target: (args) => args.id
    },
    {
        name: 'listevents',
        description: 'List server events, one CSV row per event, optionally filtered by device or user account and capped with a limit.',
        family: 'inspection',
        args: [
            { name: 'id', type: 'string', required: false, description: 'Show only events for this device id.' },
            { name: 'userid', type: 'string', required: false, description: 'Show only events for this user account.' },
            { name: 'limit', type: 'number', required: false, description: 'Maximum number of events to return.' }
        ],
        auth: { user: true, rights: ['allevents'] },
        cli: { name: 'listevents' },
        mcp: { name: 'mesh_get_events' },
        protocol: {
            action: 'events',
            params: (args) => {
                const params = {};
                if (args.userid != null) { params.user = args.userid; }
                else if (args.id != null) { params.nodeid = args.id; }
                if (args.limit != null) { params.limit = args.limit; }
                return params;
            }
        },
        format: formatEvents,
        target: (args) => ((args.userid != null) ? args.userid : ((args.id != null) ? args.id : 'all'))
    },
    pending('logintokens', 'List, create and remove account login tokens.', 'admin'),
    {
        name: 'serverinfo',
        description: 'Report the MeshCentral server information captured during the connection handshake: name, domain, ports, features and capabilities, as JSON.',
        family: 'inspection',
        args: [],
        auth: { user: true, rights: [] },
        cli: { name: 'serverinfo' },
        mcp: { name: 'mesh_server_info' },
        protocol: { from: 'serverInfo' },
        format: formatJson,
        target: null
    },
    {
        name: 'serverversion',
        description: 'Report the MeshCentral server version, including the latest and stable versions when the server advertises them.',
        family: 'inspection',
        args: [],
        auth: { user: true, rights: [] },
        cli: { name: 'serverversion' },
        mcp: { name: 'mesh_server_version' },
        protocol: { action: 'serverversion', params: () => ({}) },
        format: formatServerVersion,
        target: null
    },
    {
        name: 'userinfo',
        description: 'Report the account information of the authenticated account captured during the connection handshake, as JSON.',
        family: 'inspection',
        args: [],
        auth: { user: true, rights: [] },
        cli: { name: 'userinfo' },
        mcp: { name: 'mesh_user_info' },
        protocol: { from: 'userInfo' },
        format: formatJson,
        target: null
    },
    pending('adduser', 'Create a new user account.', 'admin'),
    pending('removeuser', 'Delete a user account.', 'admin'),
    pending('adddevicegroup', 'Create a new device group.', 'admin'),
    pending('removedevicegroup', 'Delete a device group.', 'admin'),
    pending('editdevicegroup', 'Change a device group name, description, flags, consent or invite codes.', 'admin'),
    pending('broadcast', 'Display a message to all online users, or to a single user account.', 'device'),
    pending('showevents', 'Stream server events for the account as JSON until interrupted.', 'inspection'),
    pending('addusertodevicegroup', 'Grant a user account permissions on a device group.', 'admin'),
    pending('removeuserfromdevicegroup', 'Remove a user account from a device group.', 'admin'),
    pending('addusertodevice', 'Grant a user account permissions on a single device.', 'admin'),
    pending('removeuserfromdevice', 'Remove a user account from a single device.', 'admin'),
    pending('sendinviteemail', 'Send an agent installation invitation email for a device group.', 'device'),
    pending('generateinvitelink', 'Create an agent installation invitation link for a device group.', 'device'),
    pending('config', 'Show or change the local config.json file (domains and domain values).', 'local'),
    pending('movetodevicegroup', 'Move a device to another device group.', 'device'),
    {
        name: 'deviceinfo',
        description: 'Report detailed information about one device as JSON: the node record, the last connection record, agent system information and network interfaces. System and network sections are omitted when the device is offline.',
        family: 'inspection',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' }
        ],
        auth: { user: true, rights: [] },
        cli: { name: 'deviceinfo' },
        mcp: { name: 'mesh_get_device' },
        protocol: [
            { action: 'nodes', params: () => ({}) },
            { action: 'getnetworkinfo', params: (args) => ({ nodeid: args.id }), optional: true },
            { action: 'lastconnect', params: (args) => ({ nodeid: args.id }), optional: true },
            { action: 'getsysinfo', params: (args) => ({ nodeid: args.id, nodeinfo: true }), optional: true }
        ],
        format: formatDeviceInfo,
        target: (args) => args.id
    },
    pending('removedevice', 'Delete a device.', 'device'),
    pending('editdevice', 'Change a device name, description, tags, icon or consent flags.', 'device'),
    pending('addlocaldevice', 'Add a local (non-agent) device entry.', 'device'),
    pending('addamtdevice', 'Add an Intel AMT device.', 'device'),
    pending('addusergroup', 'Create a new user group.', 'admin'),
    {
        name: 'listusergroups',
        description: 'List user groups visible to the authenticated account, as JSON, including each group\'s linked users, device groups and devices.',
        family: 'inspection',
        args: [],
        auth: { user: true, rights: ['manageusers'] },
        cli: { name: 'listusergroups' },
        mcp: { name: 'mesh_list_user_groups' },
        protocol: { action: 'usergroups', params: () => ({}) },
        format: formatUserGroups,
        target: null
    },
    pending('removeusergroup', 'Delete a user group.', 'admin'),
    pending('runcommand', 'Run a shell command on a remote device.', 'device'),
    pending('shell', 'Open an interactive shell on a remote device.', 'device'),
    pending('upload', 'Upload a file to a remote device.', 'device'),
    pending('download', 'Download a file from a remote device.', 'device'),
    pending('deviceopenurl', 'Open a URL on a remote device.', 'device'),
    pending('devicemessage', 'Display a message box on a remote device.', 'device'),
    pending('devicetoast', 'Display a toast notification on a remote device.', 'device'),
    pending('addtousergroup', 'Add a user, device or device group to a user group.', 'admin'),
    pending('removefromusergroup', 'Remove a user, device or device group from a user group.', 'admin'),
    pending('removeallusersfromusergroup', 'Remove every user from a user group.', 'admin'),
    pending('devicesharing', 'View, add and remove sharing links for a device.', 'device'),
    pending('devicepower', 'Wake, sleep, reset or power off one or more devices.', 'device'),
    pending('indexagenterrorlog', 'Index the local agent error log and report the most frequent errors.', 'local'),
    pending('agentdownload', 'Download an agent installer of a given type for a device group.', 'device'),
    pending('report', 'Create and show a CSV report (sessions, traffic, logins or database).', 'admin'),
    pending('grouptoast', 'Display a toast notification on every device in a device group.', 'device'),
    pending('groupmessage', 'Display a message box on every device in a device group.', 'device'),
    pending('webrelay', 'Create an HTTP or HTTPS web relay link for a remote device.', 'device')
];

/** Every catalogue entry, in meshctrl's command order. */
function commandNames() {
    return commands.map((entry) => entry.name);
}

/** Look up one entry by command name. */
function byName(name) {
    for (const entry of commands) {
        if (entry.name === name) { return entry; }
    }
    return null;
}

/** The entries with an MCP tool surface, in catalogue order. */
function mcpCommands() {
    return commands.filter((entry) => entry.mcp != null);
}

module.exports = {
    commands: commands,
    commandNames: commandNames,
    byName: byName,
    mcpCommands: mcpCommands,
    escapeField: escapeField,
    shortId: shortId,
    flattenNodes: flattenNodes,
    formatDeviceList: formatDeviceList
};
