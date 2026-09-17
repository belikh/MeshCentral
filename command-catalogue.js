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
 *                  { method, params?(args) }   a client method call
 *                  { local: (args) => value }  run on the bridge host
 *                  { from: 'serverInfo' }      a value captured during the
 *                                              connection handshake
 *                For a request, action may be (args) => name to pick the
 *                action per call; matchAction (true, or (args) => boolean)
 *                also resolves on a reply that quotes no responseid; and
 *                resultValue: true marks a result field that carries the
 *                command's value rather than an error. An 'optional' request
 *                may fail without failing the command.
 *   format       (value, args) => string. value is the response (single
 *                request), the ordered response array (several requests), or
 *                the handshake value (from). Returns the tool text.
 *   target       (args) => string used for the audit record, or null.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const fs = require('fs');
const path = require('path');

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

// ---------------------------------------------------------------------------
// Device action helpers: the arguments meshctrl sends to the server, here
// shared between the protocol mapping and the result formatting.
// ---------------------------------------------------------------------------

/** The runcommands parameters the CLI sends for runcommand and shell. */
function runCommandParams(args, alwaysReply) {
    let runAsUser = 0;
    if (args.runasuser) { runAsUser = 1; } else if (args.runasuseronly) { runAsUser = 2; }
    return {
        nodeids: [args.id],
        type: (args.powershell ? 2 : 0),
        cmds: args.run,
        runAsUser: runAsUser,
        reply: (alwaysReply === true) ? true : (args.reply === true)
    };
}

/**
* Render a runcommands response. The agent's completion reply is a 'msg'
* carrying the collected output; the server's dispatch acknowledgement is
* 'OK'; every other result is a rejection surfaced verbatim.
*/
function formatCommandOutput(response, acknowledgement) {
    const result = (response != null) ? response.result : null;
    if ((response != null) && (response.action === 'msg') && (response.type === 'runcommands')) {
        const output = (typeof result === 'string') ? result : '';
        return (output.length > 0) ? output : 'Command completed with no output.';
    }
    if ((result === 'ok') || (result === 'OK')) { return acknowledgement; }
    throw new Error(String(result));
}

function formatRunCommand(response, args) {
    return formatCommandOutput(response, 'Command accepted by the server; output was not requested. Re-run with reply true to capture it.');
}

function formatShellCommand(response, args) {
    return formatCommandOutput(response, 'Command accepted by the server.');
}

const POWER_ACTIONS = [
    { name: 'wake', action: 'wakedevices' },
    { name: 'off', action: 'poweraction', actiontype: 2 },
    { name: 'reset', action: 'poweraction', actiontype: 3 },
    { name: 'sleep', action: 'poweraction', actiontype: 4 },
    { name: 'amton', action: 'poweraction', actiontype: 302 },
    { name: 'amtoff', action: 'poweraction', actiontype: 308 },
    { name: 'amtreset', action: 'poweraction', actiontype: 310 }
];

const WAKE_FAILURES = [
    'Invalid nodeid',
    'Invalid domain',
    'No known MAC addresses for this device',
    'No network information for this device'
];

/** Pick the single declared power action and build its request. */
function powerRequest(args) {
    const selected = POWER_ACTIONS.filter((action) => args[action.name] === true);
    if (selected.length === 0) {
        throw new Error('A power action is required: wake, off, reset, sleep, amton, amtoff or amtreset.');
    }
    if (selected.length > 1) {
        throw new Error('Specify only one power action, not: ' + selected.map((action) => action.name).join(', ') + '.');
    }
    const nodeids = String(args.id).split(',');
    if (selected[0].action === 'wakedevices') { return { action: 'wakedevices', params: { nodeids: nodeids } }; }
    return { action: 'poweraction', params: { nodeids: nodeids, actiontype: selected[0].actiontype } };
}

function formatPowerAction(response) {
    const result = (response != null) ? response.result : null;
    if (WAKE_FAILURES.indexOf(result) >= 0) { throw new Error(result); }
    if ((result === 'ok') || (result === 'OK')) { return 'Power action accepted by the server.'; }
    return String(result);
}

const SHARE_TYPE_FLAGS = { terminal: 1, desktop: 2, files: 4, http: 8, https: 16 };

/** Turn the comma separated share types into the CLI's bit mask. */
function shareTypeMask(type) {
    let mask = 0;
    if (type != null) {
        for (const name of String(type).toLowerCase().split(',')) {
            if (SHARE_TYPE_FLAGS[name] == null) { throw new Error('Unknown sharing type: ' + name); }
            mask |= SHARE_TYPE_FLAGS[name];
        }
    }
    return (mask !== 0) ? mask : 2;
}

/** Turn the comma separated consent names into the CLI's consent bit mask. */
function shareConsentFlags(mask, consent) {
    if (consent == null) {
        let flags = 0;
        if (mask & 1) { flags |= 0x0002; }
        if (mask & 2) { flags |= 0x0001; }
        if (mask & 4) { flags |= 0x0004; }
        return flags;
    }
    let flags = 0;
    for (const name of String(consent).toLowerCase().split(',')) {
        if (name === 'none') { flags = 0; }
        else if (name === 'notify') {
            if (mask & 1) { flags |= 0x0002; }
            if (mask & 2) { flags |= 0x0001; }
            if (mask & 4) { flags |= 0x0004; }
        } else if (name === 'prompt') {
            if (mask & 1) { flags |= 0x0010; }
            if (mask & 2) { flags |= 0x0008; }
            if (mask & 4) { flags |= 0x0020; }
        } else if (name === 'bar') {
            if (mask & 2) { flags |= 0x0040; }
        } else {
            throw new Error('Unknown consent type.');
        }
    }
    return flags;
}

/** The web port for http and https shares, mirroring the CLI defaults. */
function sharePort(mask, port) {
    if (((mask & 8) === 0) && ((mask & 16) === 0)) { return null; }
    if (port != null) {
        if (!Number.isInteger(port) || (port < 1) || (port > 65535)) { throw new Error('Port number must be between 1 and 65535.'); }
        return port;
    }
    return ((mask & 8) !== 0) ? 80 : 443;
}

/** The start, end, expire and recurring values the CLI sends. */
function shareTimes(args) {
    let start = null, end = null;
    if (args.start) {
        const parsed = Date.parse(args.start);
        if (isNaN(parsed)) { throw new Error('Invalid start time.'); }
        start = Math.floor(parsed / 1000);
        end = start + (60 * 60);
    }
    if (args.end) {
        const parsed = Date.parse(args.end);
        if (isNaN(parsed)) { throw new Error('Invalid end time.'); }
        if (start == null) { start = Math.floor(Date.now() / 1000); }
        end = Math.floor(parsed / 1000);
        if (end <= start) { throw new Error('End time must be ahead of start time.'); }
    }
    if (args.duration) {
        if (start == null) { start = Math.floor(Date.now() / 1000); }
        end = start + parseInt(args.duration * 60);
    }
    let recurring = 0;
    if (args.daily && args.weekly) { throw new Error("Can't specify both --daily and --weekly at the same time."); }
    if (args.daily) { recurring = 1; } else if (args.weekly) { recurring = 2; }
    if (recurring > 0) {
        if (args.end != null) { throw new Error("End time can't be specified for recurring shares, use duration only."); }
        const duration = (args.duration == null) ? 60 : parseInt(args.duration);
        if (isNaN(duration) || (duration < 1)) { throw new Error('Invalid duration value.'); }
        if (start == null) { start = Math.floor(Date.now() / 1000); }
        return { recurring: recurring, start: start, expire: duration };
    }
    if ((start == null) && (end == null)) { return { expire: 0 }; }
    return { start: start, end: end };
}

/** The sharing request for the mode the arguments select. */
function shareRequest(args) {
    if (args.add) {
        const mask = shareTypeMask(args.type);
        const consent = shareConsentFlags(mask, args.consent);
        const port = sharePort(mask, args.port);
        const viewOnly = (args.viewonly === true);
        const times = shareTimes(args);
        if (times.recurring) {
            return { action: 'createDeviceShareLink', params: { nodeid: args.id, guestname: args.add, p: mask, consent: consent, start: times.start, expire: times.expire, recurring: times.recurring, viewOnly: viewOnly, port: port } };
        }
        if (times.expire === 0) {
            return { action: 'createDeviceShareLink', params: { nodeid: args.id, guestname: args.add, p: mask, consent: consent, expire: 0, viewOnly: viewOnly, port: port } };
        }
        return { action: 'createDeviceShareLink', params: { nodeid: args.id, guestname: args.add, p: mask, consent: consent, start: times.start, end: times.end, viewOnly: viewOnly, port: port } };
    }
    if (args.remove) {
        return { action: 'removeDeviceShare', params: { nodeid: args.id, publicid: args.remove } };
    }
    return { action: 'deviceShares', params: { nodeid: args.id } };
}

/** Render one share the way meshctrl prints it, one block per link. */
function renderDeviceShare(share) {
    const types = [];
    if (share.p & 1) { types.push('Terminal'); }
    if (share.p & 2) { types.push(share.viewOnly ? 'View Only Desktop' : 'Desktop'); }
    if (share.p & 4) { types.push('Files'); }
    const consent = [];
    if (share.consent & 0x0001) { consent.push('Desktop Notify'); }
    if (share.consent & 0x0008) { consent.push('Desktop Prompt'); }
    if (share.consent & 0x0040) { consent.push('Desktop Connection Toolbar'); }
    if (share.consent & 0x0002) { consent.push('Terminal Notify'); }
    if (share.consent & 0x0010) { consent.push('Terminal Prompt'); }
    if (share.consent & 0x0004) { consent.push('Files Notify'); }
    if (share.consent & 0x0020) { consent.push('Files Prompt'); }
    const lines = [
        '----------',
        'Identifier:   ' + share.publicid,
        'Type:         ' + ((types.length > 0) ? types.join(' + ') : 'Unknown'),
        'UserId:       ' + share.userid,
        'Guest Name:   ' + share.guestName,
        'User Consent: ' + consent.join(', ')
    ];
    if (share.startTime) { lines.push('Start Time:   ' + new Date(share.startTime).toISOString()); }
    if (share.expireTime) { lines.push('Expire Time:  ' + new Date(share.expireTime).toISOString()); }
    if (share.duration) { lines.push('Duration:     ' + share.duration + ' minute' + ((share.duration > 1) ? 's' : '')); }
    if (share.recurring == 1) { lines.push('Recurring:    Daily'); }
    if (share.recurring == 2) { lines.push('Recurring:    Weekly'); }
    lines.push('URL:          ' + share.url);
    return lines.join('\n');
}

function formatDeviceShares(value, args) {
    if (value.action === 'createDeviceShareLink') {
        const lines = [];
        if (value.publicid != null) { lines.push('ID: ' + value.publicid); }
        lines.push('URL: ' + value.url);
        return lines.join('\n');
    }
    if (value.action === 'removeDeviceShare') {
        if ((value.removed == null) && (value.result == null)) { throw new Error('Invalid device share identifier.'); }
        return 'Sharing link removed.';
    }
    const shares = Array.isArray(value.deviceShares) ? value.deviceShares : [];
    if (shares.length === 0) { return 'No device sharing links for this device.'; }
    return shares.map(renderDeviceShare).join('\n');
}

/** The webrelay request meshctrl sends, with its port defaults and checks. */
function webRelayParams(args) {
    let appid = null;
    if (args.type === 'http') { appid = 1; }
    else if (args.type === 'https') { appid = 2; }
    else { throw new Error('Unknown protocol type: ' + args.type); }
    let port = null;
    if (args.port != null) {
        if (!Number.isInteger(args.port) || (args.port < 1) || (args.port > 65535)) { throw new Error('Port number must be between 1 and 65535.'); }
        port = args.port;
    } else {
        port = (appid === 1) ? 80 : 443;
    }
    return { nodeid: args.id, port: port, appid: appid };
}

function formatWebRelay(value) {
    return 'URL: ' + value.url;
}

/** The agent download parameters meshctrl puts in the meshagents url. */
function agentDownloadParams(args) {
    if (!Number.isInteger(args.type) || (args.type < 1) || (args.type > 11000)) { throw new Error('Invalid agent type, must be a number.'); }
    const params = { type: args.type, meshid: args.id };
    if (args.installflags) {
        if (!Number.isInteger(args.installflags) || (args.installflags < 0) || (args.installflags > 2)) { throw new Error('Invalid Installflags.'); }
        params.installflags = args.installflags;
    }
    return params;
}

function formatAgentDownload(value) {
    return 'Downloaded ' + value.size + ' byte(s) to "' + value.filename + '"';
}

const AGENT_ERROR_LOG_FILENAME = 'agenterrorlogs.txt';

/**
* The agent error log location, mirroring the places meshctrl looks in:
* meshcentral-data next to the running code or its parent, then the working
* directory and its parent.
*/
function agentErrorLogPath() {
    const candidates = [
        path.join(process.cwd(), 'meshcentral-data', AGENT_ERROR_LOG_FILENAME),
        path.join(__dirname, 'meshcentral-data', AGENT_ERROR_LOG_FILENAME),
        path.join(process.cwd(), '..', 'meshcentral-data', AGENT_ERROR_LOG_FILENAME),
        path.join(__dirname, '..', 'meshcentral-data', AGENT_ERROR_LOG_FILENAME)
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) { return candidate; }
    }
    return candidates[0];
}

/**
* Index the agent error log the way meshctrl's indexAgentErrorLog does: each
* line is a node id, a fetch time and an errorlog JSON payload; messages are
* counted and the STUCK and FATAL ones returned most frequent first.
*/
function indexAgentErrorLog(text) {
    const counts = new Map();
    for (const line of String(text).split('\r\n')) {
        if (line.length <= 88) { continue; }
        let data = null;
        try { data = JSON.parse(line.substring(87)); } catch (ex) { continue; }
        if ((data == null) || (data.action !== 'errorlog') || !Array.isArray(data.log)) { continue; }
        for (const entry of data.log) {
            if ((entry != null) && (typeof entry.t === 'number') && (typeof entry.m === 'string')) {
                counts.set(entry.m, (counts.get(entry.m) || 0) + 1);
            }
        }
    }
    const indexed = Array.from(counts.entries()).map(([message, count]) => ({ message: message, count: count }));
    indexed.sort((a, b) => b.count - a.count);
    return indexed.filter((entry) => (entry.message.indexOf('STUCK') >= 0) || (entry.message.indexOf('FATAL') >= 0));
}

function formatAgentErrorLog(index) {
    if ((index == null) || (index.length === 0)) { return 'No STUCK or FATAL agent error messages found.'; }
    return index.map((entry) => entry.count + ' ' + entry.message).join('\n');
}

function readAgentErrorLog() {
    const filePath = agentErrorLogPath();
    let text = null;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (ex) {
        throw new Error('Unable to read the agent error log at ' + filePath + ': ' + ex.message);
    }
    return indexAgentErrorLog(text);
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
    {
        name: 'runcommand',
        description: 'Run a shell command on a remote device. By default the server accepts the command and returns immediately; with reply true the call waits for the command to finish and returns its collected output. A reply wait is bounded by the bridge per-command timeout (default 30 seconds, configured with --commandtimeout); a timeout is reported verbatim.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'run', type: 'string', required: true, description: 'Shell command to execute on the remote device.' },
            { name: 'powershell', type: 'boolean', required: false, description: 'Run in Windows PowerShell instead of the default shell.' },
            { name: 'runasuser', type: 'boolean', required: false, description: 'Attempt to run the command as the logged in user.' },
            { name: 'runasuseronly', type: 'boolean', required: false, description: 'Only run the command as the logged in user.' },
            { name: 'reply', type: 'boolean', required: false, description: 'Wait for the command to finish and return its output. The wait is bounded by the bridge command timeout.' }
        ],
        auth: { user: true, rights: ['remotecommands', 'agentconsole'] },
        cli: { name: 'runcommand' },
        mcp: { name: 'mesh_run_command' },
        protocol: {
            action: 'runcommands',
            params: (args) => runCommandParams(args, false),
            resultValue: true
        },
        format: formatRunCommand,
        target: (args) => args.id
    },
    {
        name: 'shell',
        description: 'Run a single shell command on a remote device and return its output when the command completes. The bridge does not hold an interactive terminal session: supply the command text with the call and the tool returns at completion. The wait is bounded by the bridge per-command timeout (default 30 seconds, configured with --commandtimeout); a timeout is reported verbatim.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'run', type: 'string', required: true, description: 'Shell command to execute on the remote device.' },
            { name: 'powershell', type: 'boolean', required: false, description: 'Run a Windows PowerShell command instead of the default shell.' },
            { name: 'runasuser', type: 'boolean', required: false, description: 'Attempt to run the command as the logged in user.' },
            { name: 'runasuseronly', type: 'boolean', required: false, description: 'Only run the command as the logged in user.' }
        ],
        auth: { user: true, rights: ['remotecommands', 'agentconsole'] },
        cli: { name: 'shell' },
        mcp: { name: 'mesh_shell' },
        protocol: {
            action: 'runcommands',
            params: (args) => runCommandParams(args, true),
            resultValue: true
        },
        format: formatShellCommand,
        target: (args) => args.id
    },
    pending('upload', 'Upload a file to a remote device.', 'device'),
    pending('download', 'Download a file from a remote device.', 'device'),
    {
        name: 'deviceopenurl',
        description: 'Open a URL in the default browser on a remote device. The server acknowledges routing the request; the device does not confirm that the page opened.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'openurl', type: 'string', required: true, description: 'URL to open on the remote device.' }
        ],
        auth: { user: true, rights: ['remotecontrol'] },
        cli: { name: 'deviceopenurl' },
        mcp: { name: 'mesh_device_open_url' },
        protocol: { action: 'msg', params: (args) => ({ type: 'openUrl', nodeid: args.id, url: args.openurl }) },
        format: () => 'Open URL request sent to the device.',
        target: (args) => args.id
    },
    {
        name: 'devicemessage',
        description: 'Display a message box on a remote device. The server acknowledges routing the request; the device does not confirm that the box was shown. The box closes after the timeout, or stays open when the timeout is zero.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'msg', type: 'string', required: true, description: 'Message to display.' },
            { name: 'title', type: 'string', required: false, description: 'Message box title, default "MeshCentral".' },
            { name: 'timeout', type: 'number', required: false, description: 'Milliseconds before the message box vanishes; 0 keeps it open until closed by hand. The CLI default is 120000.' }
        ],
        auth: { user: true, rights: ['remotecontrol'] },
        cli: { name: 'devicemessage' },
        mcp: { name: 'mesh_device_message' },
        protocol: {
            action: 'msg',
            params: (args) => {
                const params = { type: 'messagebox', nodeid: args.id, title: (args.title ? args.title : 'MeshCentral'), msg: args.msg };
                params.timeout = (args.timeout ? args.timeout : 120000);
                return params;
            }
        },
        format: () => 'Message box sent to the device.',
        target: (args) => args.id
    },
    {
        name: 'devicetoast',
        description: 'Display a toast notification on a remote device. The server acknowledges routing the request; the device does not confirm that the toast was shown.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'msg', type: 'string', required: true, description: 'Message to display.' },
            { name: 'title', type: 'string', required: false, description: 'Toast title, default "MeshCentral".' }
        ],
        auth: { user: true, rights: ['remotecontrol'] },
        cli: { name: 'devicetoast' },
        mcp: { name: 'mesh_device_toast' },
        protocol: { action: 'toast', params: (args) => ({ nodeids: [args.id], title: (args.title ? args.title : 'MeshCentral'), msg: args.msg }) },
        format: () => 'Toast notification sent to the device.',
        target: (args) => args.id
    },
    pending('addtousergroup', 'Add a user, device or device group to a user group.', 'admin'),
    pending('removefromusergroup', 'Remove a user, device or device group from a user group.', 'admin'),
    pending('removeallusersfromusergroup', 'Remove every user from a user group.', 'admin'),
    {
        name: 'devicesharing',
        description: 'View, add and remove sharing links for a device. With add a new guest sharing link is created and its identifier and URL returned; with remove a link is deleted; with neither the existing links are listed. Recurring links take a duration in minutes; time limited links take a start and end time, or a start and duration.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'add', type: 'string', required: false, description: 'Guest name for a new sharing link.' },
            { name: 'remove', type: 'string', required: false, description: 'Public identifier of the sharing link to remove.' },
            { name: 'type', type: 'string', required: false, description: 'Comma separated link types: desktop, terminal, files, http, https. Default desktop.' },
            { name: 'viewonly', type: 'boolean', required: false, description: 'Make a desktop sharing link view only.' },
            { name: 'consent', type: 'string', required: false, description: 'Comma separated consent names: notify, prompt, bar, none. Default notify for the selected types.' },
            { name: 'start', type: 'string', required: false, description: 'Start time, e.g. 2026-09-17T10:00:00Z, default now.' },
            { name: 'end', type: 'string', required: false, description: 'End time, e.g. 2026-09-17T11:00:00Z.' },
            { name: 'duration', type: 'number', required: false, description: 'Length of the link in minutes, default 60.' },
            { name: 'daily', type: 'boolean', required: false, description: 'Create a recurring daily link; use duration only.' },
            { name: 'weekly', type: 'boolean', required: false, description: 'Create a recurring weekly link; use duration only.' },
            { name: 'port', type: 'number', required: false, description: 'Alternative http or https port, default 80 for http and 443 for https.' }
        ],
        auth: { user: true, rights: ['guestsharing'] },
        cli: { name: 'devicesharing' },
        mcp: { name: 'mesh_device_sharing' },
        protocol: {
            action: (args) => shareRequest(args).action,
            params: (args) => shareRequest(args).params,
            matchAction: (args) => shareRequest(args).action === 'deviceShares'
        },
        format: formatDeviceShares,
        target: (args) => args.id
    },
    {
        name: 'devicepower',
        description: 'Wake, sleep, reset or power off one or more devices, or perform an Intel AMT power action. Exactly one action is required. The server acknowledges the request without waiting for the device: note that a wake, sleep, reset or power off may take up to a minute to take effect, and the result is reported from the server\'s own acknowledgement, not from the device.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Comma separated device ids (node//...) or unique parts of them.' },
            { name: 'wake', type: 'boolean', required: false, description: 'Wake the device with wake-on-LAN.' },
            { name: 'off', type: 'boolean', required: false, description: 'Power the device off.' },
            { name: 'reset', type: 'boolean', required: false, description: 'Reset the device.' },
            { name: 'sleep', type: 'boolean', required: false, description: 'Place the device in low power mode.' },
            { name: 'amton', type: 'boolean', required: false, description: 'Power on through Intel AMT.' },
            { name: 'amtoff', type: 'boolean', required: false, description: 'Power off through Intel AMT.' },
            { name: 'amtreset', type: 'boolean', required: false, description: 'Reset through Intel AMT.' }
        ],
        auth: { user: true, rights: ['wakedevice', 'resetoff'] },
        cli: { name: 'devicepower' },
        mcp: { name: 'mesh_device_power' },
        protocol: {
            action: (args) => powerRequest(args).action,
            params: (args) => powerRequest(args).params,
            resultValue: true
        },
        format: formatPowerAction,
        target: (args) => args.id
    },
    {
        name: 'indexagenterrorlog',
        description: 'Index the local agent error log (meshcentral-data/agenterrorlogs.txt on the bridge host) and report the most frequent STUCK and FATAL agent error messages, most frequent first. The same log and filter the CLI uses; no server round trip.',
        family: 'local',
        args: [],
        auth: { user: true, rights: [] },
        cli: { name: 'indexagenterrorlog' },
        mcp: { name: 'mesh_index_agent_error_log' },
        protocol: { local: () => readAgentErrorLog() },
        format: formatAgentErrorLog,
        target: null
    },
    {
        name: 'agentdownload',
        description: 'Download an agent installer of a given architecture for a device group and save it next to the bridge, using the server\'s meshagents endpoint as the CLI does. The download completes before the call returns and is bounded by the bridge per-command timeout (default 30 seconds, configured with --commandtimeout); a timeout is reported verbatim. An existing file is never overwritten.',
        family: 'device',
        args: [
            { name: 'type', type: 'number', required: true, description: 'Agent architecture number, 1 to 11000 (for example 3 for Windows 64 bit).' },
            { name: 'id', type: 'string', required: true, description: 'Device group id (mesh//...).' },
            { name: 'installflags', type: 'number', required: false, description: 'Installer flags 0 to 2: 0 interactive and background, 1 interactive only, 2 background only.' }
        ],
        auth: { user: true, rights: ['agentdownload'] },
        cli: { name: 'agentdownload' },
        mcp: { name: 'mesh_agent_download' },
        protocol: { method: 'downloadAgent', params: (args) => agentDownloadParams(args) },
        format: formatAgentDownload,
        target: (args) => args.id
    },
    pending('report', 'Create and show a CSV report (sessions, traffic, logins or database).', 'admin'),
    pending('grouptoast', 'Display a toast notification on every device in a device group.', 'device'),
    pending('groupmessage', 'Display a message box on every device in a device group.', 'device'),
    {
        name: 'webrelay',
        description: 'Create an HTTP or HTTPS web relay link for a remote device and return its URL. The server acknowledges the request and builds the link; opening the link is left to the caller.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'type', type: 'string', required: true, description: 'Protocol of the service on the device: http or https.' },
            { name: 'port', type: 'number', required: false, description: 'Alternative port, default 80 for http and 443 for https.' }
        ],
        auth: { user: true, rights: ['remotecontrol'] },
        cli: { name: 'webrelay' },
        mcp: { name: 'mesh_web_relay' },
        protocol: { action: 'webrelay', params: (args) => webRelayParams(args) },
        format: formatWebRelay,
        target: (args) => args.id
    }
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
