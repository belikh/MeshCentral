'use strict';

const crypto = require('crypto');

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
 *                'cli' names the meshctrl flag when it differs from name, and
 *                an optional 'cliMessage' is the exact text the CLI prints
 *                when the argument is missing. The MCP tool schema and its
 *                validation are generated from the declared arguments only;
 *                the CLI argument handling is generated from the same list.
 *   auth         Descriptive rights metadata: { user: true, rights: [...] }
 *                where rights lists the server permission names an account
 *                typically needs. It documents, it does not enforce: the
 *                server remains the only authority. Null when undeclared.
 *   cli          { name, format, checks? } mapping onto the meshctrl command.
 *                'format' renders the command value as the bytes meshctrl
 *                prints; it is called with (value, args, cli) where cli is the
 *                parse of the raw command line (json, raw, csv, hex and the
 *                like). Returning null prints nothing. 'checks' is an optional
 *                ordered argument check list: { arg } (a declared argument is
 *                required), { anyOf: [...] } (one of the flags must be present)
 *                or { test: (argv) => boolean }, each carrying the exact
 *                message to print when it fails. A command the catalogue
 *                cannot express is not silently hand written in meshctrl: it
 *                is enumerated with its reason in CLI_EXCEPTIONS
 *                (cli-dispatch.js), and the tests keep that list complete.
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
 *                also resolves on a reply that quotes no responseid;
 *                byAction true resolves on a reply that omits the responseid
 *                and must be matched on its action (login tokens, reports);
 *                resultValue: true marks a result field that carries the
 *                command's value rather than an error; follow
 *                (response, args) => spec[] issues requests derived from a
 *                response, such as one membership removal per user; and an
 *                'optional' request may fail without failing the command.
 *   format       (value, args) => string. The MCP tool text.
 *   target       (args) => string used for the audit record, or null.
 *   omitted      True on a command the bridge specification deliberately
 *                leaves without a tool surface (file transfer). It keeps its
 *                CLI command and its catalogue position; 'pending' keeps
 *                meaning work remaining.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

/** Replace quotes and line breaks so one field stays on one text line. */
function escapeField(value) {
    return String((value != null) ? value : '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

/** The last path segment of a MeshCentral identifier, e.g. mesh//abc -> abc. */
function shortId(id) {
    const parts = String(id).split('/');
    return (parts.length > 2) ? parts[2] : String(id);
}

/** True when an identifier names the requested id, whole or short. */
function matchesId(id, candidate) {
    return (candidate === id) || (shortId(candidate) === id);
}

/** The first record whose identifier names id, whole or short, or null. */
function findById(records, id) {
    for (const record of records) {
        if (matchesId(id, record._id)) { return record; }
    }
    return null;
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
        return (findById(meshes, args.idexists) != null) ? '1' : '0';
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
        return (findById(users, args.idexists) != null) ? '1' : '0';
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

/** Render the per-account web session counts meshctrl prints. */
function formatUserSessions(response) {
    const sessions = ((response != null) && (response.wssessions != null)) ? response.wssessions : {};
    const userIds = Object.keys(sessions);
    if (userIds.length === 0) { return 'No active user sessions.'; }
    return userIds.map((userid) => userid + ', ' + ((sessions[userid] > 1) ? (sessions[userid] + ' sessions.') : '1 session.')).join('\n');
}

function formatUserGroups(response) {
    return JSON.stringify((response.ugroups != null) ? response.ugroups : {}, null, 2);
}

function formatDeviceGroupUsers(response, args) {
    const meshes = Array.isArray(response.meshes) ? response.meshes : [];
    const mesh = findById(meshes, args.id);
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

/**
* Render the account event snapshot as JSON. The CLI streams live events and
* prints each one; the bridge returns the server's snapshot of the same events,
* filtered on the same event actions the CLI filters on.
*/
function formatShownEvents(response, args) {
    const events = ((response != null) && Array.isArray(response.events)) ? response.events : [];
    let selected = events;
    if (args.filter != null) {
        const filters = String(args.filter).split(',');
        selected = events.filter((event) => (filters.indexOf(event.action) >= 0));
    }
    if (selected.length === 0) { return 'No events.'; }
    return JSON.stringify(selected, null, 2);
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

/** Complete a bare user id with a domain the way meshctrl does. */
function completeUserId(id, domain) {
    if ((domain != null) && (String(id).indexOf('/') < 0)) { return 'user/' + domain + '/' + id; }
    return String(id);
}

/** Complete a bare user group id with a domain the way meshctrl does. */
function completeUserGroupId(id, domain) {
    if ((domain != null) && (String(id).indexOf('/') < 0)) { return 'ugrp/' + domain + '/' + id; }
    return String(id);
}

/**
* Server administrator rights from the meshctrl --rights value: an exact
* number, or a comma separated list of the names meshctrl understands.
*/
function siteAdminRights(args) {
    var siteadmin = -1;
    if (typeof args.rights == 'number') {
        siteadmin = args.rights;
    } else if (typeof args.rights == 'string') {
        if (/^[0-9]+$/.test(args.rights.trim())) {
            // A numeric value reaches meshctrl as a number; the tool schema
            // carries it as text, so accept both spellings.
            siteadmin = parseInt(args.rights.trim(), 10);
        } else {
            siteadmin = 0;
            const srights = args.rights.toLowerCase().split(',');
            if (srights.indexOf('full') != -1) { siteadmin = 0xFFFFFFFF; }
            if (srights.indexOf('none') != -1) { siteadmin = 0x00000000; }
            if ((srights.indexOf('backup') != -1) || (srights.indexOf('serverbackup') != -1)) { siteadmin |= 0x00000001; }
            if (srights.indexOf('manageusers') != -1) { siteadmin |= 0x00000002; }
            if ((srights.indexOf('restore') != -1) || (srights.indexOf('serverrestore') != -1)) { siteadmin |= 0x00000004; }
            if (srights.indexOf('fileaccess') != -1) { siteadmin |= 0x00000008; }
            if ((srights.indexOf('update') != -1) || (srights.indexOf('serverupdate') != -1)) { siteadmin |= 0x00000010; }
            if (srights.indexOf('locked') != -1) { siteadmin |= 0x00000020; }
            if (srights.indexOf('nonewgroups') != -1) { siteadmin |= 0x00000040; }
            if (srights.indexOf('notools') != -1) { siteadmin |= 0x00000080; }
            if (srights.indexOf('usergroups') != -1) { siteadmin |= 0x00000100; }
            if (srights.indexOf('recordings') != -1) { siteadmin |= 0x00000200; }
            if (srights.indexOf('locksettings') != -1) { siteadmin |= 0x00000400; }
            if (srights.indexOf('allevents') != -1) { siteadmin |= 0x00000800; }
            if (srights.indexOf('nonewdevices') != -1) { siteadmin |= 0x00001000; }
        }
    }
    return siteadmin;
}

// The per-device rights bits the addusertodevice flags set. The device group
// ladder shares this run and adds its own administration bits, so the two
// commands cannot drift apart.
const DEVICE_RIGHTS_FLAGS = [
    ['remotecontrol', 8],
    ['agentconsole', 16],
    ['serverfiles', 32],
    ['wakedevices', 64],
    ['notes', 128],
    ['desktopviewonly', 256],
    ['noterminal', 512],
    ['nofiles', 1024],
    ['noamt', 2048],
    ['limiteddesktop', 4096],
    ['limitedevents', 8192],
    ['chatnotify', 16384],
    ['uninstall', 32768],
    ['noregistry', 4194304],
    ['nosoftware', 8388608]
];

// The device group administration bits only addusertodevicegroup sets.
const DEVICE_GROUP_RIGHTS_FLAGS = [
    ['editgroup', 1],
    ['manageusers', 2],
    ['managedevices', 4]
];

// The standard remote device rights addusertodevice --fullrights grants.
const DEVICE_FULL_RIGHTS = (8 + 16 + 32 + 64 + 128 + 16384 + 32768);

/** OR the selected flag bits onto an initial mask. */
function rightsFromFlags(args, flags, initial) {
    let rights = initial;
    for (const flag of flags) {
        if (args[flag[0]]) { rights |= flag[1]; }
    }
    return rights;
}

/** Device group permissions from the meshctrl addusertodevicegroup flags. */
function deviceGroupRights(args) {
    return rightsFromFlags(args, DEVICE_GROUP_RIGHTS_FLAGS.concat(DEVICE_RIGHTS_FLAGS), args.fullrights ? 0xFFFFFFFF : 0);
}

/** Device permissions from the meshctrl addusertodevice flags. */
function deviceRights(args) {
    return rightsFromFlags(args, DEVICE_RIGHTS_FLAGS, args.fullrights ? DEVICE_FULL_RIGHTS : 0);
}

/** Generate an Intel AMT compliant random password, as meshctrl --randompass. */
function checkAmtPassword(p) { return (p.length > 7) && (/\d/.test(p)) && (/[a-z]/.test(p)) && (/[A-Z]/.test(p)) && (/\W/.test(p)); }
function randomPassword() {
    var password;
    do { password = Buffer.from(crypto.randomBytes(9), 'binary').toString('base64').split('/').join('@'); } while (checkAmtPassword(password) == false);
    return password;
}

/** Render the result of a mutation the way meshctrl prints it. */
function formatActionResult(response) {
    if (response == null) { return ''; }
    if (response.meshid != null) { return String(response.result) + ' ' + response.meshid; }
    if (response.userid != null) { return String(response.result) + ' ' + response.userid; }
    return String(response.result);
}

/** Pad a login token column exactly as meshctrl's padString does. */
function padTokenColumn(value, pad) {
    const text = String(value);
    const xpad = '                                                                                                         ';
    if (text.length >= pad) { return text; }
    return text + xpad.substring(0, pad - text.length);
}

/** Render login token listings and creations the way meshctrl prints them. */
function formatLoginTokens(response, args) {
    if (args.add) {
        if (response.result != null) { return String(response.result); }
        let text = 'New login token created.';
        if (response.name) { text += '\nToken name: ' + response.name; }
        if (response.created) { text += '\nCreated: ' + new Date(response.created).toLocaleString(); }
        if (response.expire) { text += '\nExpire: ' + new Date(response.expire).toLocaleString(); }
        if (response.tokenUser) { text += '\nUsername: ' + response.tokenUser; }
        if (response.tokenPass) { text += '\nPassword: ' + response.tokenPass; }
        return text;
    }
    const tokens = Array.isArray(response.loginTokens) ? response.loginTokens : [];
    const lines = [
        'Name                        Username                    Expire',
        '-------------------------------------------------------------------------------------'
    ];
    if (tokens.length === 0) { lines.push('No login tokens'); return lines.join('\n'); }
    for (const token of tokens) {
        const expire = (token.expire === 0) ? 'Unlimited' : new Date(token.expire).toLocaleString();
        lines.push(padTokenColumn(token.name, 28) + padTokenColumn(token.tokenUser, 28) + expire);
    }
    return lines.join('\n');
}

/** Render a report response as the CSV meshctrl prints. */
function formatReport(response) {
    const data = (response != null) ? response.data : null;
    if ((data == null) || !Array.isArray(data.columns) || (data.groups == null)) {
        return JSON.stringify(response, null, 2);
    }
    const lines = ['group,' + data.columns.flatMap((column) => column.id).join(',')];
    for (const key of Object.keys(data.groups)) {
        const group = data.groups[key];
        const entries = ((group != null) && Array.isArray(group.entries)) ? group.entries : [];
        for (const entry of entries) { lines.push(key + ',' + Object.values(entry).join(',')); }
    }
    return lines.join('\n');
}

/** The user group memberships to remove, in the order the server listed them. */
function userGroupUserIds(groupId, domain) {
    return function (response) {
        const groups = ((response != null) && (response.ugroups != null)) ? response.ugroups : {};
        const group = groups[completeUserGroupId(groupId, domain)];
        if ((group == null) || (group.links == null)) { return []; }
        return Object.keys(group.links).filter((id) => id.startsWith('user/'));
    };
}

/** Render the result of removing every user from a user group. */
function formatRemoveAllUsersFromUserGroup(responses, args) {
    const groups = ((responses[0] != null) && (responses[0].ugroups != null)) ? responses[0].ugroups : {};
    const group = groups[completeUserGroupId(args.groupid, args.domain)];
    if (group == null) { return 'User group not found.'; }
    const userIds = userGroupUserIds(args.groupid, args.domain)(responses[0]);
    if (userIds.length === 0) { return 'No users in this user group.'; }
    const lines = userIds.map((id) => 'Removing ' + id);
    const last = responses[responses.length - 1];
    if ((last != null) && (last.result != null)) { lines.push(String(last.result)); }
    return lines.join('\n');
}

/** The kind of membership identifier meshctrl accepts: user, mesh or node. */
function memberKind(args) {
    if (args.userid != null) { return 'user'; }
    if (args.meshid != null) { return 'mesh'; }
    if (args.nodeid != null) { return 'node'; }
    if (String(args.id).startsWith('user/')) { return 'user'; }
    if (String(args.id).startsWith('mesh/')) { return 'mesh'; }
    if (String(args.id).startsWith('node/')) { return 'node'; }
    return null;
}

/** The action that adds or removes one membership identifier. */
function membershipAction(args, add) {
    const kind = memberKind(args);
    if (kind === 'user') { return add ? 'addusertousergroup' : 'removeuserfromusergroup'; }
    if (kind === 'mesh') { return add ? 'addmeshuser' : 'removemeshuser'; }
    if (kind === 'node') { return 'adddeviceuser'; }
    throw new Error('The identifier must start with user/, mesh/ or node/.');
}

/** The protocol params for adding a user, device group or device to a user group. */
function addToUserGroupParams(args) {
    const kind = memberKind(args);
    const ugrpid = completeUserGroupId(args.groupid, args.domain);
    const rights = (args.rights != null) ? parseInt(args.rights, 10) : 0;
    if (kind === 'user') {
        const userid = (args.userid != null) ? args.userid : args.id;
        return { ugrpid: ugrpid, usernames: [String(userid).split('/')[2]] };
    }
    if (kind === 'mesh') {
        return { meshid: (args.meshid != null) ? args.meshid : args.id, userid: ugrpid, meshadmin: rights };
    }
    if (kind === 'node') {
        return { nodeid: (args.nodeid != null) ? args.nodeid : args.id, userids: [ugrpid], rights: rights };
    }
    throw new Error('The identifier must start with user/, mesh/ or node/.');
}

/** The protocol params for removing a user, device group or device from a user group. */
function removeFromUserGroupParams(args) {
    const kind = memberKind(args);
    const ugrpid = completeUserGroupId(args.groupid, args.domain);
    if (kind === 'user') { return { ugrpid: ugrpid, userid: (args.userid != null) ? args.userid : args.id }; }
    if (kind === 'mesh') { return { meshid: (args.meshid != null) ? args.meshid : args.id, userid: ugrpid }; }
    if (kind === 'node') { return { nodeid: (args.nodeid != null) ? args.nodeid : args.id, userids: [ugrpid], rights: 0, remove: true }; }
    throw new Error('The identifier must start with user/, mesh/ or node/.');
}

/** Throw the message meshctrl prints when a device group identifier is missing. */
function requireDeviceGroup(args) {
    if (!args.meshid && !args.group) {
        throw new Error("Device group identifier missing, use --id '[groupid]' or --group [groupname]");
    }
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

/**
* A command deliberately left without a tool surface by the bridge
* specification, so 'pending' keeps meaning work remaining. It keeps its
* catalogue position and its CLI command.
*/
function omitted(name, description, family) {
    const entry = pending(name, description, family);
    entry.omitted = true;
    return entry;
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

/** The device ids of a nodes response, listed by device group in server order. */
function deviceIdsByGroup(nodes) {
    const groups = [];
    if ((nodes == null) || (typeof nodes !== 'object')) { return groups; }
    for (const meshid of Object.keys(nodes)) {
        const group = nodes[meshid];
        if (!Array.isArray(group)) { continue; }
        const ids = [];
        for (const node of group) { ids.push(node._id); }
        groups.push(ids);
    }
    return groups;
}

/** The number of devices the first response of a fan-out carries. */
function countGroupDevices(responses) {
    return flattenNodes(((responses != null) && (responses[0] != null)) ? responses[0].nodes : null).length;
}

/** Render the outcome of sending a message box to every device in a group. */
function formatGroupMessage(responses) {
    const count = countGroupDevices(responses);
    if (count === 0) { return 'No devices in this device group.'; }
    return 'Message box sent to ' + count + ' device' + ((count === 1) ? '.' : 's.');
}

/** Render the outcome of sending a toast to every device in a group. */
function formatGroupToast(responses) {
    const count = countGroupDevices(responses);
    if (count === 0) { return 'No devices in this device group.'; }
    return 'Toast notification sent to ' + count + ' device' + ((count === 1) ? '.' : 's.');
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

// ---------------------------------------------------------------------------
// Edit-device helpers: the tag arithmetic and request meshctrl's editdevice
// performs, shared by its direct and read-then-write protocol paths.
// ---------------------------------------------------------------------------

/** Find one device by its exact id in a nodes response, as meshctrl does. */
function findNode(nodes, id) {
    if ((nodes == null) || (typeof nodes !== 'object')) { return null; }
    for (const meshid of Object.keys(nodes)) {
        const group = nodes[meshid];
        if (!Array.isArray(group)) { continue; }
        for (const node of group) {
            if (node._id === id) { return node; }
        }
    }
    return null;
}

/** Apply the comma separated addtag and removetag values meshctrl accepts. */
function editDeviceTags(currentTags, args) {
    let tags = Array.isArray(currentTags) ? currentTags.slice() : [];
    if (args.addtag) {
        for (const addtag of String(args.addtag).split(',')) {
            const tag = addtag.trim();
            if (tag && (tags.indexOf(tag) < 0)) { tags.push(tag); }
        }
    }
    if (args.removetag) {
        const removetags = String(args.removetag).split(',').map((tag) => tag.trim());
        tags = tags.filter((tag) => (removetags.indexOf(tag) < 0));
    }
    return tags;
}

/**
* The changedevice parameters meshctrl sends. currentTags is the tag list read
* from the device when addtag or removetag was used, and null on the direct
* path, where the tags argument replaces the tag list wholesale.
*/
function editDeviceParams(args, currentTags) {
    let icon = null, consent = null;
    if (args.icon) {
        icon = parseInt(args.icon, 10);
        if (isNaN(icon) || (icon < 1) || (icon > 8)) { throw new Error('Icon must be between 1 and 8.'); }
    }
    if (args.consent) {
        consent = parseInt(args.consent, 10);
        if (isNaN(consent) || (consent < 1)) { throw new Error('Invalid consent flags.'); }
    }
    const op = { nodeid: args.id };
    if (typeof args.name == 'string') { op.name = args.name; }
    if (args.desc) { op.desc = args.desc; }
    if (currentTags != null) { op.tags = editDeviceTags(currentTags, args); }
    else if (args.tags) { op.tags = String(args.tags).split(','); }
    if (icon != null) { op.icon = icon; }
    if (consent != null) { op.consent = consent; }
    return op;
}

/** Render the last response of a device edit, the changedevice reply. */
function formatDeviceChange(responses) {
    return formatActionResult(responses[responses.length - 1]);
}

/** Render an invitation link response the way meshctrl prints it. */
function formatInviteLink(response) {
    return response.url ? String(response.url) : String(response.result);
}

// ---------------------------------------------------------------------------
// CLI rendering: the exact bytes meshctrl prints for a command result. The
// functions below are the CLI half of each entry's presentation, declared on
// the entry as cli.format next to the MCP format. They are called with the
// command value, the built argument object and the parsed command line, and
// return the printed text (null prints nothing). Keeping them here, beside
// the MCP formats and the protocol mapping, is what stops the CLI from
// drifting away from the catalogue.
// ---------------------------------------------------------------------------

/** Print one field of a serverinfo or userinfo response the way the CLI does. */
function cliFieldLine(key, value) {
    return key + ': ' + ((typeof value === 'string') ? value : util.inspect(value));
}

function cliServerInfo(value, args, cli) {
    if (cli.json) { return JSON.stringify(value, ' ', 2); }
    const lines = [];
    for (const key of Object.keys(value)) { lines.push(cliFieldLine(key, value[key])); }
    return lines.join('\n');
}

function cliServerVersion(value, args, cli) {
    if (cli.json) { return JSON.stringify(value.tags, ' ', 2); }
    return formatServerVersion(value);
}

/** The CLI listusers rendering: filter, then --json, then the two probes. */
function cliUsers(value, args, cli) {
    let users = Array.isArray(value.users) ? value.users : [];
    if (args.filter != null) {
        const filters = String(args.filter).toLowerCase().split(',');
        users = users.filter((user) => {
            const twoFactor = (user.otphkeys != null) || (user.otpkeys != null) || (user.otpsecret != null);
            if ((filters.indexOf('2fa') >= 0) && twoFactor) { return true; }
            if ((filters.indexOf('no2fa') >= 0) && (twoFactor === false)) { return true; }
            return false;
        });
    }
    if (cli.json) { return JSON.stringify(users, ' ', 2); }
    if (args.idexists != null) {
        for (const user of users) {
            if ((user._id == args.idexists) || (String(user._id).split('/')[2] == args.idexists)) { return '1'; }
        }
        return '0';
    }
    if (args.nameexists != null) {
        for (const user of users) {
            if (user.name == args.nameexists) { return user._id; }
        }
        return null;
    }
    const lines = ['id, name, email\r\n---------------'];
    for (const user of users) {
        let line = '"' + String(user._id).split('/')[2] + '", "' + user.name + '"';
        if (user.email != null) { line += ', "' + user.email + '"'; }
        lines.push(line);
    }
    return lines.join('\n');
}

/** The CLI listusersessions rendering: no sessions prints nothing at all. */
function cliUserSessions(value, args, cli) {
    const sessions = ((value != null) && (value.wssessions != null)) ? value.wssessions : {};
    if (cli.json) { return JSON.stringify(sessions, ' ', 2); }
    const lines = [];
    for (const id of Object.keys(sessions)) {
        lines.push(id + ', ' + ((sessions[id] > 1) ? (sessions[id] + ' sessions.') : '1 session.'));
    }
    return (lines.length > 0) ? lines.join('\n') : null;
}

/** The CLI listusergroups rendering: a tree by default, JSON on request. */
function cliUserGroups(value, args, cli) {
    const groups = ((value != null) && (value.ugroups != null)) ? value.ugroups : {};
    if (cli.json) { return JSON.stringify(groups, ' ', 2); }
    const lines = [];
    for (const id of Object.keys(groups)) {
        const group = groups[id];
        let header = id + ', ' + group.name;
        if (group.desc && (group.desc != '')) { header += ', ' + group.desc; }
        lines.push(header);
        const mesh = [], user = [], node = [];
        if (group.links != null) {
            for (const link of Object.keys(group.links)) {
                if (link.startsWith('mesh/')) { mesh.push(link); }
                if (link.startsWith('user/')) { user.push(link); }
                if (link.startsWith('node/')) { node.push(link); }
            }
        }
        lines.push('  Users:');
        if (user.length > 0) { for (const link of user) { lines.push('    ' + link); } } else { lines.push('    (None)'); }
        lines.push('  Device Groups:');
        if (mesh.length > 0) { for (const link of mesh) { lines.push('    ' + link + ', ' + group.links[link].rights); } } else { lines.push('    (None)'); }
        lines.push('  Devices:');
        if (node.length > 0) { for (const link of node) { lines.push('    ' + link + ', ' + group.links[link].rights); } } else { lines.push('    (None)'); }
    }
    return lines.join('\n');
}

/** The CLI listdevicegroups rendering, including its --json/--hex forms. */
function cliDeviceGroups(value, args, cli) {
    const meshes = Array.isArray(value.meshes) ? value.meshes : [];
    if (cli.json) {
        if (args.hex) {
            return JSON.stringify(meshes.map((mesh) => Object.assign({}, mesh, { _idhex: formatMeshId(mesh._id, true) })), ' ', 2);
        }
        return JSON.stringify(meshes, ' ', 2);
    }
    if (args.idexists != null) {
        for (const mesh of meshes) {
            if ((mesh._id == args.idexists) || (String(mesh._id).split('/')[2] == args.idexists)) { return '1'; }
        }
        return '0';
    }
    if (args.nameexists != null) {
        for (const mesh of meshes) {
            if (mesh.name == args.nameexists) { return mesh._id; }
        }
        return null;
    }
    const lines = ['id, name\r\n---------------'];
    for (const mesh of meshes) {
        const mid = (args.hex === true) ? formatMeshId(mesh._id, true) : shortId(mesh._id);
        lines.push('"' + mid + '", "' + mesh.name + '"');
    }
    return lines.join('\n');
}

/**
* The CLI listusersofdevicegroup rendering. The CLI matches only the base64
* id segment, unlike the tool, which accepts a full mesh// id as well.
*/
function cliDeviceGroupUsers(value, args, cli) {
    const meshes = Array.isArray(value.meshes) ? value.meshes : [];
    for (const mesh of meshes) {
        if (String(mesh._id).split('/')[2] == args.id) {
            if (cli.json) { return JSON.stringify(mesh.links, ' ', 2); }
            const lines = ['userid, rights\r\n---------------'];
            for (const id of Object.keys(mesh.links)) {
                lines.push(String(id).split('/')[2] + ', ' + meshRightsNames(mesh.links[id].rights).join(', '));
            }
            return lines.join('\n');
        }
    }
    return 'Group id not found';
}

/** The CLI CSV cell formatting, kept bit for bit so its quirks are unchanged. */
function csvFormatArray(x) {
    var y = [];
    for (var i in x) { if ((x[i] == null) || (x[i] == '')) { y.push(''); } else { y.push('"' + x[i].split('"').join('') + '"'); } }
    return y.join(',');
}

/** The CLI listevents rendering: --raw, --json, then the three CSV shapes. */
function cliEvents(value, args, cli) {
    const events = Array.isArray(value.events) ? value.events : [];
    if (cli.raw) { return JSON.stringify(events); }
    if (cli.json) { return JSON.stringify(events, ' ', 2); }
    const lines = [];
    if ((args.id == null) && (args.userid == null)) {
        lines.push('time,type,action,nodeid,userid,msg');
        for (const event of events) { lines.push(csvFormatArray([event.time, event.etype, event.action, event.nodeid, event.userid, event.msg])); }
    } else if (args.id != null) {
        lines.push('time,type,action,userid,msg');
        for (const event of events) { lines.push(csvFormatArray([event.time, event.etype, event.action, event.userid, event.msg])); }
    } else {
        lines.push('time,type,action,nodeid,msg');
        for (const event of events) { lines.push(csvFormatArray([event.time, event.etype, event.action, event.nodeid, event.msg])); }
    }
    return lines.join('\n');
}

/** The CLI indexagenterrorlog rendering: silent when nothing is STUCK/FATAL. */
function cliAgentErrorLog(index) {
    if ((index == null) || (index.length === 0)) { return null; }
    return formatAgentErrorLog(index);
}

/** The CLI logintokens rendering: --json inspects, everything else prints. */
function cliLoginTokens(value, args, cli) {
    if (cli.json) {
        if (args.add) {
            // The CLI's responseid is fixed, and --json printed it verbatim.
            return util.inspect(Object.assign({}, value, { responseid: 'meshctrl' }));
        }
        return util.inspect(value.loginTokens);
    }
    return formatLoginTokens(value, args);
}

/** The CLI's message, toast and open-url acknowledgement: the server result. */
function cliResult(value) {
    return String(value.result);
}

/** The CLI runcommand rendering: the server result, collected output included. */
function cliRunCommand(value) {
    return String(value.result);
}

/** The CLI devicepower rendering: the server result, wake failures included. */
function cliPowerAction(value) {
    return String(value.result);
}

/** The CLI groupmessage rendering: it always reports the dispatch. */
function cliGroupMessage() {
    return 'ok';
}

/** The CLI grouptoast rendering: the last toast reply; none sent prints nothing. */
function cliGroupToast(value) {
    if (!Array.isArray(value) || (value.length < 2)) { return null; }
    return String(value[value.length - 1].result);
}

/** The CLI devicesharing rendering, including its locale date strings. */
function cliDeviceShares(value, args, cli) {
    if (value.action === 'createDeviceShareLink') {
        const lines = [];
        if (value.publicid != null) { lines.push('ID: ' + value.publicid); }
        lines.push('URL: ' + value.url);
        return lines.join('\n');
    }
    if (value.action === 'removeDeviceShare') {
        return String(value.result);
    }
    const shares = Array.isArray(value.deviceShares) ? value.deviceShares : [];
    if (shares.length === 0) { return 'No device sharing links for this device.'; }
    if (cli.json) { return util.inspect(shares); }
    const blocks = [];
    for (const share of shares) {
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
        if (share.startTime) { lines.push('Start Time:   ' + new Date(share.startTime).toLocaleString()); }
        if (share.expireTime) { lines.push('Expire Time:  ' + new Date(share.expireTime).toLocaleString()); }
        if (share.duration) { lines.push('Duration:     ' + share.duration + ' minute' + ((share.duration > 1) ? 's' : '')); }
        if (share.recurring == 1) { lines.push('Recurring:    Daily'); }
        if (share.recurring == 2) { lines.push('Recurring:    Weekly'); }
        lines.push('URL:          ' + share.url);
        blocks.push(lines.join('\n'));
    }
    return blocks.join('\n');
}

/** The CLI webrelay rendering. */
function cliWebRelay(value) {
    return 'URL: ' + value.url;
}

/** The CLI's template replacement for device information labels. */
function formatTemplate(text) {
    const values = Array.prototype.slice.call(arguments, 1);
    return text.replace(/{(\d+)}/g, function (match, number) { return (typeof values[number] != 'undefined') ? values[number] : match; });
}

/** Agent architecture names, in the order meshctrl prints them. */
const AGENT_ARCHITECTURES = ["Unknown", "Windows 32bit console", "Windows 64bit console", "Windows 32bit service", "Windows 64bit service", "Linux 32bit", "Linux 64bit", "MIPS", "XENx86", "Android", "Linux ARM", "macOS x86-32bit", "Android x86", "PogoPlug ARM", "Android", "Linux Poky x86-32bit", "macOS x86-64bit", "ChromeOS", "Linux Poky x86-64bit", "Linux NoKVM x86-32bit", "Linux NoKVM x86-64bit", "Windows MinCore console", "Windows MinCore service", "NodeJS", "ARM-Linaro", "ARMv6l / ARMv7l", "ARMv8 64bit", "ARMv6l / ARMv7l / NoKVM", "MIPS24KC (OpenWRT)", "Apple Silicon", "FreeBSD x86-64", "Unknown", "Linux ARM 64 bit", "Alpine Linux x86 64 Bit (MUSL)", "Assistant (Windows)", "Armada370 - ARM32/HF (libc/2.26)", "OpenWRT x86-64", "OpenBSD x86-64", "Unknown", "Unknown", "MIPSEL24KC (OpenWRT)", "ARMADA/CORTEX-A53/MUSL (OpenWRT)", "Windows ARM 64bit console", "Windows ARM 64bit service", "ARMVIRT32 (OpenWRT)", "RISC-V x86-64"];

/**
* The CLI deviceinfo rendering: the sectioned text report, or the raw and
* JSON forms. Ported from the hand-written CLI so the output is unchanged.
*/
function cliDeviceInfo(responses, args, cli) {
    const nodes = responses[0] || null;
    const network = responses[1] || null;
    const lastconnect = responses[2] || null;
    const sysinfo = responses[3] || null;

    // Fetch the node information
    var node = null;
    if ((sysinfo != null) && (sysinfo.node != null)) {
        node = sysinfo.node;
    } else if ((nodes != null) && (nodes.nodes != null)) {
        for (var m in nodes.nodes) {
            for (var n in nodes.nodes[m]) {
                if (nodes.nodes[m][n]._id.indexOf(args.id) >= 0) { node = nodes.nodes[m][n]; }
            }
        }
    }
    if (((sysinfo == null) && (lastconnect == null) && (network == null)) || (node == null)) {
        return 'Invalid device id';
    }

    var info = {};
    if (lastconnect != null) { node.lastconnect = lastconnect.time; node.lastaddr = lastconnect.addr; }
    if (cli.raw) { return JSON.stringify(Object.assign({}, sysinfo, { responseid: 'meshctrl' }), ' ', 2); }

    // General
    var output = {}, outputCount = 0;
    if (node.name) { output["Server Name"] = node.name; outputCount++; }
    if (node.rname) { output["Computer Name"] = node.rname; outputCount++; }
    if (node.host != null) { output["Hostname"] = node.host; outputCount++; }
    if (node.ip != null) { output["IP Address"] = node.ip; outputCount++; }
    if (node.desc != null) { output["Description"] = node.desc; outputCount++; }
    if (node.icon != null) { output["Icon"] = node.icon; outputCount++; }
    if (node.tags) { output["Tags"] = node.tags; outputCount++; }
    if (node.av && node.av.length > 0) {
        var av = [];
        for (var i in node.av) {
            if (typeof node.av[i]['product'] == 'string') {
                var name = node.av[i]['product'];
                if (node.av[i]['updated'] === true) { name += ', updated'; }
                if (node.av[i]['updated'] === false) { name += ', not updated'; }
                if (node.av[i]['enabled'] === true) { name += ', enabled'; }
                if (node.av[i]['enabled'] === false) { name += ', disabled'; }
                av.push(name);
            }
        }
        output["AntiVirus"] = av; outputCount++;
    }
    if (typeof node.defender == 'object') { output["Windows Defender"] = node.defender; outputCount++; }
    if (node.pr && node.pr.length > 0) {
        var pr = [];
        for (var i in node.pr) { pr.push(node.pr[i]); }
        output["Pending Reboot"] = pr; outputCount++;
    }
    if (typeof node.wsc == 'object') { output["Windows Security Center"] = node.wsc; outputCount++; }
    if (typeof node.lsc == 'object') { output["Linux Security Center"] = node.lsc; outputCount++; }
    if (outputCount > 0) { info["General"] = output; }

    // Operating System
    var hardware = null;
    if ((sysinfo != null) && (sysinfo.hardware != null)) { hardware = sysinfo.hardware; }
    if ((hardware && hardware.windows && hardware.windows.osinfo) || (hardware && hardware.linux) || node.osdesc) {
        var output = {}, outputCount = 0;
        if (node.rname) { output["Name"] = node.rname; outputCount++; }
        if (node.osdesc) { output["Version"] = node.osdesc; outputCount++; }
        if (hardware && hardware.windows && hardware.windows.osinfo) { var m = hardware.windows.osinfo; if (m.OSArchitecture) { output["Architecture"] = m.OSArchitecture; outputCount++; } }
        if (hardware && hardware.linux) {
            if (hardware.linux.arch) { output["Architecture"] = hardware.linux.arch; outputCount++; }
            if (hardware.linux.kernel_release) { output["Kernel Release"] = hardware.linux.kernel_release; outputCount++; }
            if (hardware.linux.kernel_build) { output["Kernel Build"] = hardware.linux.kernel_build; outputCount++; }
        }
        if (outputCount > 0) { info["Operating System"] = output; }
    }

    // MeshAgent
    if (node.agent) {
        var output = {}, outputCount = 0;
        if ((node.agent != null) && (node.agent.id != null) && (node.agent.ver != null)) {
            var str = '';
            if (node.agent.id <= AGENT_ARCHITECTURES.length) { str = AGENT_ARCHITECTURES[node.agent.id]; } else { str = AGENT_ARCHITECTURES[0]; }
            if (node.agent.ver != 0) { str += ' v' + node.agent.ver; }
            output["Mesh Agent"] = str; outputCount++;
        }
        if ((node.conn & 1) != 0) {
            output["Last agent connection"] = "Connected now"; outputCount++;
        } else {
            if (node.lastconnect) { output["Last agent connection"] = new Date(node.lastconnect).toLocaleString(); outputCount++; }
        }
        output["Agent status"] = ((node.conn & 1) != 0) ? "Connected now" : "Offline"; outputCount++;
        if (node.lastaddr) {
            var splitip = node.lastaddr.split(':');
            if (splitip.length > 2) {
                output["Last agent address"] = node.lastaddr; outputCount++;
            } else {
                output["Last agent address"] = splitip[0]; outputCount++;
            }
        }
        if ((node.agent != null) && (node.agent.tag != null)) { output["Tag"] = node.agent.tag; outputCount++; }
        if (outputCount > 0) { info["Mesh Agent"] = output; }
    }

    // Networking
    if ((network != null) && (network.netif != null)) {
        var output = {}, outputCount = 0, minfo = {};
        for (var i in network.netif) {
            var m = network.netif[i], moutput = {}, moutputCount = 0;
            if (m.desc) { moutput["Description"] = m.desc; moutputCount++; }
            if (m.mac) {
                if (m.gatewaymac) {
                    moutput["MAC Layer"] = formatTemplate("MAC: {0}, Gateway: {1}", m.mac, m.gatewaymac); moutputCount++;
                } else {
                    moutput["MAC Layer"] = formatTemplate("MAC: {0}", m.mac); moutputCount++;
                }
            }
            if (m.v4addr && (m.v4addr != '0.0.0.0')) {
                if (m.v4gateway && m.v4mask) {
                    moutput["IPv4 Layer"] = formatTemplate("IP: {0}, Mask: {1}, Gateway: {2}", m.v4addr, m.v4mask, m.v4gateway); moutputCount++;
                } else {
                    moutput["IPv4 Layer"] = formatTemplate("IP: {0}", m.v4addr); moutputCount++;
                }
            }
            if (moutputCount > 0) { minfo[m.name + (m.dnssuffix ? (', ' + m.dnssuffix) : '')] = moutput; info["Networking"] = minfo; }
        }
    }

    if ((network != null) && (network.netif2 != null)) {
        var minfo = {};
        for (var i in network.netif2) {
            var m = network.netif2[i], moutput = {}, moutputCount = 0;
            if ((Array.isArray(m) == false) || (m.length < 1) || (m[0] == null) ||
                ((typeof m[0].mac == 'string') && (m[0].mac.startsWith('00:00:00:00')))) {
                continue;
            }
            var ifTitle = '' + i;
            if ((m[0].fqdn != null) && (m[0].fqdn != '')) { ifTitle += ', ' + m[0].fqdn; }
            if (typeof m[0].mac == 'string') {
                if (m[0].gatewaymac) {
                    moutput['MAC Layer'] = formatTemplate("MAC: {0}, Gateway: {1}", m[0].mac, m[0].gatewaymac);
                } else {
                    moutput['MAC Layer'] = formatTemplate("MAC: {0}", m[0].mac);
                }
                moutputCount++;
            }
            moutput['IPv4 Layer'] = '';
            moutput['IPv6 Layer'] = '';
            for (var j = 0; j < m.length; j++) {
                var iplayer = m[j];
                if ((iplayer.family == 'IPv4') || (iplayer.family == 'IPv6')) {
                    if (iplayer.gateway && iplayer.netmask) {
                        moutput[iplayer.family + ' Layer'] += formatTemplate("IP: {0}, Mask: {1}, Gateway: {2}  ", iplayer.address, iplayer.netmask, iplayer.gateway);
                        moutputCount++;
                    } else if (iplayer.address) {
                        moutput[iplayer.family + ' Layer'] += formatTemplate("IP: {0}  ", iplayer.address);
                        moutputCount++;
                    }
                }
            }
            if (moutput['IPv4 Layer'] == '') { delete moutput['IPv4 Layer']; }
            if (moutput['IPv6 Layer'] == '') { delete moutput['IPv6 Layer']; }
            if (moutputCount > 0) {
                minfo[ifTitle] = moutput;
                info["Networking"] = minfo;
            }
        }
    }

    // Intel AMT
    if (node.intelamt != null) {
        var output = {}, outputCount = 0;
        output["Version"] = (node.intelamt.ver) ? ('v' + node.intelamt.ver) : ('<i>' + "Unknown" + '</i>'); outputCount++;
        var provisioningStates = { 0: "Not Activated (Pre)", 1: "Not Activated (In)", 2: "Activated" };
        var provisioningMode = '';
        if ((node.intelamt.state == 2) && node.intelamt.flags) { if (node.intelamt.flags & 2) { provisioningMode = (', ' + "Client Control Mode (CCM)"); } else if (node.intelamt.flags & 4) { provisioningMode = (', ' + "Admin Control Mode (ACM)"); } }
        output["Provisioning State"] = ((node.intelamt.state) ? (provisioningStates[node.intelamt.state]) : ('<i>' + "Unknown" + '</i>')) + provisioningMode; outputCount++;
        output["Security"] = (node.intelamt.tls == 1) ? "Secured using TLS" : "TLS is not setup"; outputCount++;
        output["Admin Credentials"] = ((node.intelamt.user == null) || (node.intelamt.user == '')) ? "Not Known" : "Known"; outputCount++;
        if (outputCount > 0) { info["Intel Active Management Technology (Intel AMT)"] = output; }
    }

    if (hardware != null) {
        if (hardware.identifiers) {
            var output = {}, outputCount = 0, ident = hardware.identifiers;
            if (ident.bios_vendor) { output["Vendor"] = ident.bios_vendor; outputCount++; }
            if (ident.bios_version) { output["Version"] = ident.bios_version; outputCount++; }
            if (ident.bios_serial) { output["Serial"] = ident.bios_serial; outputCount++; }
            if (ident.bios_mode) { output["Mode"] = ident.bios_mode; outputCount++; }
            if (outputCount > 0) { info["BIOS"] = output; }
            output = {}, outputCount = 0;
            if (ident.board_vendor) { output["Vendor"] = ident.board_vendor; outputCount++; }
            if (ident.board_name) { output["Name"] = ident.board_name; outputCount++; }
            if (ident.board_serial && (ident.board_serial != '')) { output["Serial"] = ident.board_serial; outputCount++; }
            if (ident.board_version) { output["Version"] = ident.board_version; }
            if (ident.product_uuid) { output["Identifier"] = ident.product_uuid; }
            if (ident.cpu_name) { output["CPU"] = ident.cpu_name; }
            if (ident.gpu_name) { for (var i in ident.gpu_name) { output["GPU" + (parseInt(i) + 1)] = ident.gpu_name[i]; } }
            if (outputCount > 0) { info["Motherboard"] = output; }
            output = {}, outputCount = 0;
            if (ident.chassis_manufacturer) { output["Manufacturer"] = ident.chassis_manufacturer; outputCount++; }
            if (ident.product_name) { output["Product Name"] = ident.product_name; outputCount++; }
            if (ident.chassis_serial) { output["Serial"] = ident.chassis_serial; outputCount++; }
            if (ident.chassis_assettag) { output["Asset Tag"] = ident.chassis_assettag; outputCount++; }
            if (outputCount > 0) { info["System"] = output; }
            output = {}, outputCount = 0;
        }

        if (hardware.tpm) {
            var output = {}, outputCount = 0, tpm = hardware.tpm;
            if (tpm.SpecVersion) { output["SpecVersion"] = parseFloat(tpm.SpecVersion).toFixed(1); outputCount++; }
            if (tpm.ManufacturerId) { output["Identifier"] = tpm.ManufacturerId; outputCount++; }
            if (tpm.ManufacturerVersion) { output["Version"] = tpm.ManufacturerVersion; outputCount++; }
            if (tpm.IsActivated != null) { output["Activated"] = (tpm.IsActivated ? "Yes" : "No"); outputCount++; }
            if (tpm.IsEnabled != null) { output["Enabled"] = (tpm.IsEnabled ? "Yes" : "No"); outputCount++; }
            if (tpm.IsOwned != null) { output["Owned"] = (tpm.IsOwned ? "Yes" : "No"); outputCount++; }
            if (outputCount > 0) { info["TPM"] = output; }
            output = {}, outputCount = 0;
        }

        if (hardware.windows && hardware.windows.memory) {
            var output = {}, outputCount = 0, minfo = {};
            hardware.windows.memory.sort(function (a, b) { if (a.BankLabel > b.BankLabel) return 1; if (a.BankLabel < b.BankLabel) return -1; return 0; });
            for (var i in hardware.windows.memory) {
                var m = hardware.windows.memory[i], moutput = {}, moutputCount = 0;
                if (m.Capacity && m.Speed) { moutput["Capacity/Speed"] = (m.Capacity / 1024 / 1024) + " Mb, " + m.Speed + " Mhz"; moutputCount++; }
                else if (m.Capacity) { moutput["Capacity"] = (m.Capacity / 1024 / 1024) + " Mb"; moutputCount++; }
                if (m.PartNumber) { moutput["Part Number"] = ((m.Manufacturer && m.Manufacturer != 'Undefined') ? (m.Manufacturer + ', ') : '') + m.PartNumber; moutputCount++; }
                if (moutputCount > 0) { minfo[m.BankLabel ? m.BankLabel : (m.DeviceLocator ? m.DeviceLocator : 'Unknown')] = moutput; info["Memory"] = minfo; }
            }
        }

        if (hardware.identifiers && hardware.identifiers.storage_devices) {
            var output = {}, outputCount = 0, minfo = {};
            var ident = hardware.identifiers;
            ident.storage_devices.sort(function (a, b) { if (a.Caption > b.Caption) return 1; if (a.Caption < b.Caption) return -1; return 0; });
            for (var i in ident.storage_devices) {
                var m = ident.storage_devices[i], moutput = {};
                if (m.Size) {
                    if (m.Model && (m.Model != m.Caption)) { moutput["Model"] = m.Model; outputCount++; }
                    if ((typeof m.Size == 'string') && (parseInt(m.Size) == m.Size)) { m.Size = parseInt(m.Size); }
                    if (typeof m.Size == 'number') { moutput["Capacity"] = Math.floor(m.Size / 1024 / 1024) + 'Mb'; outputCount++; }
                    if (typeof m.Size == 'string') { moutput["Capacity"] = m.Size; outputCount++; }
                    if (moutputCount > 0) { minfo[m.Caption] = moutput; info["Storage"] = minfo; }
                }
            }
        }

        if (hardware.windows && hardware.windows.volumes) { info["Volumes"] = hardware.windows.volumes; }
        if (hardware.windows && hardware.windows.bitlocker) { info["Bitlocker cache"] = hardware.windows.bitlocker; }
    }

    if (cli.json) { return JSON.stringify(info, ' ', 2); }
    const lines = [];
    for (var i in info) {
        lines.push('--- ' + i + ' ---');
        for (var j in info[i]) {
            if ((typeof info[i][j] == 'string') || (typeof info[i][j] == 'number')) {
                lines.push('  ' + j + ': ' + info[i][j]);
            } else {
                lines.push('  ' + j + ':');
                for (var k in info[i][j]) {
                    lines.push('    ' + k + ': ' + info[i][j][k]);
                }
            }
        }
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Config helpers: the local config.json operations meshctrl's config command
// performs. Only the operation flags are declared here; the CLI's free-form
// domain value flags (--title, --newAccounts and the like) cannot be expressed
// as fixed tool schema arguments, so the tool matches the CLI invoked without
// any of them.
// ---------------------------------------------------------------------------

/** The config.json meshctrl would load, in its search order, or null. */
function configFilePath() {
    const candidates = [
        path.join(process.cwd(), 'config.json'),
        path.join(process.cwd(), 'meshcentral-data', 'config.json'),
        path.join(__dirname, 'config.json'),
        path.join(__dirname, 'meshcentral-data', 'config.json'),
        path.join(__dirname, '..', 'meshcentral-data', 'config.json'),
        path.join(__dirname, '..', '..', 'meshcentral-data', 'config.json')
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) { return candidate; }
    }
    return null;
}

/** The help meshctrl prints when the config command is given no operation. */
function configHelpText() {
    return [
        'Perform operations on the config.json file. Example usage:',
        '',
        '  MeshCtrl config --show',
        '',
        'Optional arguments:',
        '',
        '  --show                        - Display the config.json file.',
        '  --listdomains                 - Display non-default domains.',
        '  --adddomain [domain]          - Add a domain.',
        '  --removedomain [domain]       - Remove a domain.',
        '  --settodomain [domain]        - Set values to the domain.',
        '  --removefromdomain [domain]   - Remove values from the domain.',
        '',
        'With adddomain, removedomain, settodomain and removefromdomain you can add the key and value pair. For example:',
        '',
        '  --adddomain "MyDomain" --title "My Server Name" --newAccounts false',
        '  --settodomain "MyDomain" --themePack "Stylish-UI"',
        '  --settodomain "MyDomain" --title "My Server Name"',
        '  --removefromdomain "MyDomain" --title'
    ].join('\n');
}

/**
* Perform the meshctrl config operations against the local config.json and
* return { action, messages, config?, domains? } for formatConfig to render.
* Read and parse failures throw the message the CLI prints.
*/
function readConfig(args) {
    const filePath = configFilePath();
    if (filePath == null) { throw new Error('Unable to find config.json.'); }
    let text = null;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch (ex) { throw new Error('Error: Unable to read config.json'); }
    let config = null;
    try { config = JSON.parse(text); } catch (ex) { throw new Error('ERROR: Unable to parse ' + filePath + '.'); }

    const messages = [];
    let didSomething = 0, configChange = false;
    if (args.adddomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (config.domains[args.adddomain] != null) { messages.push('Error: Domain "' + args.adddomain + '" already exists'); }
        else { config.domains[args.adddomain] = {}; configChange = true; }
    }
    if (args.removedomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (config.domains[args.removedomain] == null) { messages.push('Error: Domain "' + args.removedomain + '" does not exist'); }
        else { delete config.domains[args.removedomain]; configChange = true; }
    }
    if (args.settodomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (config.domains[args.settodomain] == null) { messages.push('Error: Domain "' + args.settodomain + '" does not exist'); }
    }
    if (args.removefromdomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (config.domains[args.removefromdomain] == null) { messages.push('Error: Domain "' + args.removefromdomain + '" does not exist'); }
    }
    if (configChange) {
        try { fs.writeFileSync(filePath, JSON.stringify(config, null, 2)); } catch (ex) { throw new Error('Error: Unable to read config.json'); }
    }
    if (args.show) { return { action: 'show', messages: messages, config: config }; }
    if (args.listdomains) {
        if (config.domains == null) { return { action: 'listdomains', messages: messages, domains: null }; }
        const domains = [];
        for (const name of Object.keys(config.domains)) {
            if ((name != '') && (name[0] != '_')) { domains.push(name); }
        }
        return { action: 'listdomains', messages: messages, domains: domains };
    }
    if (didSomething === 0) { return { action: 'help', messages: messages }; }
    return { action: 'done', messages: messages };
}

/** Render a config operation the way meshctrl prints it. */
function formatConfig(result) {
    const lines = result.messages.slice();
    if (result.action === 'show') { lines.push(JSON.stringify(result.config, null, 2)); }
    else if (result.action === 'listdomains') {
        if (result.domains == null) { lines.push('No domains found.'); }
        else { for (const domain of result.domains) { lines.push(domain); } }
    } else if (result.action === 'help') { lines.push(configHelpText()); }
    else { lines.push('Done.'); }
    return lines.join('\n');
}

/** The audit target of a config operation: the domain it names, or the file. */
function configTarget(args) {
    for (const name of ['adddomain', 'removedomain', 'settodomain', 'removefromdomain']) {
        if (args[name] != null) { return args[name]; }
    }
    return 'config';
}

const commands = [
    {
        name: 'edituser',
        description: 'Change an existing user account: email, real name, phone number, account rights and password reset on next login. Requires account administration rights on the server.',
        family: 'admin',
        args: [
            { name: 'userid', type: 'string', required: true, description: 'User account id (user//...) or its bare name.' },
            { name: 'domain', type: 'string', required: false, description: 'Account domain, only for cross-domain administrators.' },
            { name: 'email', type: 'string', required: false, description: 'New email address for the account.' },
            { name: 'emailverified', type: 'boolean', required: false, description: 'Mark the new email address as verified.' },
            { name: 'resetpass', type: 'boolean', required: false, description: 'Request a password reset on the next account login.' },
            { name: 'realname', type: 'string', required: false, description: 'New real name; an empty string clears it.' },
            { name: 'phone', type: 'string', required: false, description: 'New phone number; an empty string clears it.' },
            { name: 'rights', type: 'string', required: false, description: 'Server permissions: none, full or a comma separated list of manageusers, serverbackup, serverrestore, serverupdate, fileaccess, locked, nonewgroups, notools, usergroups, recordings, locksettings, allevents, nonewdevices.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'edituser',
            format: formatActionResult,
            checks: [
                { arg: 'userid', message: 'Edit account user missing, use --userid [id]' }
            ]
        },
        mcp: { name: 'mesh_edit_user' },
        protocol: {
            action: 'edituser',
            params: (args) => {
                const op = { userid: completeUserId(args.userid, args.domain) };
                if (args.email) { op.email = args.email; if (args.emailverified === true) { op.emailVerified = true; } }
                if (args.resetpass === true) { op.resetNextLogin = true; }
                const siteadmin = siteAdminRights(args);
                if (siteadmin != -1) { op.siteadmin = siteadmin; }
                if (args.domain) { op.domain = args.domain; }
                if (args.phone != null) { op.phone = args.phone; }
                if (args.realname != null) { op.realname = args.realname; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.userid
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
        cli: { name: 'listusers', format: cliUsers },
        mcp: { name: 'mesh_list_users' },
        protocol: { action: 'users', params: () => ({}) },
        format: formatUsers,
        target: (args) => ((args.filter != null) ? args.filter : 'all')
    },
    {
        name: 'listusersessions',
        description: 'List the number of active web sessions for each online user account, one line per account with the account id and its session count.',
        family: 'inspection',
        args: [],
        auth: { user: true, rights: ['manageusers'] },
        cli: { name: 'listusersessions', format: cliUserSessions },
        mcp: { name: 'mesh_list_user_sessions' },
        protocol: { action: 'wssessioncount', params: () => ({}), matchAction: true },
        format: formatUserSessions,
        target: null
    },
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
        cli: { name: 'listdevicegroups', format: cliDeviceGroups },
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
        cli: {
            name: 'listusersofdevicegroup',
            format: cliDeviceGroupUsers,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" }
            ]
        },
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
        cli: {
            name: 'listevents',
            format: cliEvents,
            prepare: (args) => {
                // The CLI drops a limit that is not a positive integer.
                if (args.limit != null) {
                    const limit = parseInt(args.limit, 10);
                    if (isNaN(limit) || (limit < 1)) { delete args.limit; } else { args.limit = limit; }
                }
            }
        },
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
    {
        name: 'logintokens',
        description: 'List the login tokens of the authenticated account, create a token with a given name and lifetime, or remove a token by user name. A created token\'s username and password are returned once and cannot be retrieved again.',
        family: 'admin',
        args: [
            { name: 'add', type: 'string', required: false, description: 'Create a login token with this name.' },
            { name: 'expire', type: 'number', required: false, description: 'Minutes until the new token expires; 0 or omitted means it does not expire.' },
            { name: 'remove', type: 'string', required: false, description: 'Remove the login token with this user name.' }
        ],
        auth: { user: true, rights: [] },
        cli: { name: 'logintokens', format: cliLoginTokens },
        mcp: { name: 'mesh_login_tokens' },
        protocol: {
            action: (args) => (args.add ? 'createLoginToken' : 'loginTokens'),
            byAction: true,
            params: (args) => {
                if (args.add) {
                    const op = { name: args.add, expire: 0 };
                    if (args.expire) { op.expire = parseInt(args.expire, 10); }
                    return op;
                }
                const op = {};
                if (args.remove) { op.remove = [args.remove]; }
                return op;
            }
        },
        format: formatLoginTokens,
        target: (args) => (args.add ? args.add : (args.remove ? args.remove : null))
    },
    {
        name: 'serverinfo',
        description: 'Report the MeshCentral server information captured during the connection handshake: name, domain, ports, features and capabilities, as JSON.',
        family: 'inspection',
        args: [],
        auth: { user: true, rights: [] },
        cli: { name: 'serverinfo', format: cliServerInfo },
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
        cli: { name: 'serverversion', format: cliServerVersion },
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
        cli: { name: 'userinfo', format: cliServerInfo },
        mcp: { name: 'mesh_user_info' },
        protocol: { from: 'userInfo' },
        format: formatJson,
        target: null
    },
    {
        name: 'adduser',
        description: 'Create a new user account with an email address, real name, phone number, server rights and an optional password reset on next login. The account password is either supplied or generated randomly.',
        family: 'admin',
        args: [
            { name: 'user', type: 'string', required: true, description: 'New account name.' },
            { name: 'pass', type: 'string', required: false, description: 'New account password; required unless randompass is set.' },
            { name: 'randompass', type: 'boolean', required: false, description: 'Generate a random Intel AMT compliant password for the new account.' },
            { name: 'domain', type: 'string', required: false, description: 'Account domain, only for cross-domain administrators.' },
            { name: 'email', type: 'string', required: false, description: 'New account email address.' },
            { name: 'emailverified', type: 'boolean', required: false, description: 'Mark the new email address as verified.' },
            { name: 'resetpass', type: 'boolean', required: false, description: 'Request a password reset on the first account login.' },
            { name: 'realname', type: 'string', required: false, description: 'Real name for this account.' },
            { name: 'phone', type: 'string', required: false, description: 'Phone number for this account; an empty string clears it.' },
            { name: 'rights', type: 'string', required: false, description: 'Server permissions: none, full or a comma separated list of manageusers, serverbackup, serverrestore, serverupdate, fileaccess, locked, nonewgroups, notools, usergroups, recordings, locksettings, allevents, nonewdevices.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'adduser',
            format: formatActionResult,
            checks: [
                { arg: 'user', message: 'New account name missing, use --user [name]' },
                { test: (argv) => (argv.pass != null) || (argv.randompass != null), message: 'New account password missing, use --pass [password] or --randompass' }
            ]
        },
        mcp: { name: 'mesh_add_user' },
        protocol: {
            action: 'adduser',
            params: (args) => {
                if ((args.pass == null) && (args.randompass !== true)) {
                    throw new Error('New account password missing, use --pass [password] or --randompass');
                }
                const op = { username: args.user, pass: (args.randompass === true) ? randomPassword() : args.pass };
                if (args.email) { op.email = args.email; if (args.emailverified === true) { op.emailVerified = true; } }
                if (args.resetpass === true) { op.resetNextLogin = true; }
                const siteadmin = siteAdminRights(args);
                if (siteadmin != -1) { op.siteadmin = siteadmin; }
                if (args.domain) { op.domain = args.domain; }
                if (args.phone != null) { op.phone = args.phone; }
                if (args.realname != null) { op.realname = args.realname; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.user
    },
    {
        name: 'removeuser',
        description: 'Delete a user account. Requires account administration rights on the server.',
        family: 'admin',
        args: [
            { name: 'userid', type: 'string', required: true, description: 'User account id (user//...) or its bare name.' },
            { name: 'domain', type: 'string', required: false, description: 'Account domain, only for cross-domain administrators.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'removeuser',
            format: formatActionResult,
            checks: [
                { arg: 'userid', message: 'Remove account userid missing, use --userid [id]' }
            ]
        },
        mcp: { name: 'mesh_remove_user' },
        protocol: {
            action: 'deleteuser',
            params: (args) => ({ userid: completeUserId(args.userid, args.domain) })
        },
        format: formatActionResult,
        target: (args) => args.userid
    },
    {
        name: 'adddevicegroup',
        description: 'Create a new device group, optionally Intel AMT only or agent-less, with a description, device group features and user consent flags.',
        family: 'admin',
        args: [
            { name: 'name', type: 'string', required: true, description: 'Name of the new device group.' },
            { name: 'desc', type: 'string', required: false, description: 'New device group description.' },
            { name: 'amtonly', type: 'boolean', required: false, description: 'Create an Intel AMT only device group (meshtype 1).' },
            { name: 'agentless', type: 'boolean', required: false, description: 'Create an agent-less device group (meshtype 3).' },
            { name: 'features', type: 'number', required: false, description: 'Device group features: 1 auto-remove, 2 hostname sync, 4 record sessions.' },
            { name: 'consent', type: 'number', required: false, description: 'User consent flags: 1 desktop notify, 2 terminal notify, 4 files notify, 8 desktop prompt, 16 terminal prompt, 32 files prompt, 64 desktop toolbar.' }
        ],
        auth: { user: true, rights: [] },
        cli: {
            name: 'adddevicegroup',
            format: formatActionResult,
            checks: [
                { arg: 'name', message: 'Message group name, use --name [name]' }
            ]
        },
        mcp: { name: 'mesh_add_device_group' },
        protocol: {
            action: 'createmesh',
            params: (args) => {
                const op = { meshname: args.name, meshtype: 2 };
                if (args.desc) { op.desc = args.desc; }
                if (args.amtonly) { op.meshtype = 1; }
                if (args.agentless) { op.meshtype = 3; }
                if (args.features) { op.flags = parseInt(args.features, 10); }
                if (args.consent) { op.consent = parseInt(args.consent, 10); }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.name
    },
    {
        name: 'removedevicegroup',
        description: 'Delete a device group and every device record in it, named by group id or group name.',
        family: 'admin',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Device group name.' }
        ],
        auth: { user: true, rights: [] },
        cli: {
            name: 'removedevicegroup',
            format: formatActionResult,
            checks: [
                { anyOf: ['meshid', 'group'], message: "Device group identifier missing, use --id '[groupid]' or --group [groupname]" }
            ]
        },
        mcp: { name: 'mesh_remove_device_group' },
        protocol: {
            action: 'deletemesh',
            params: (args) => {
                requireDeviceGroup(args);
                const op = {};
                if (args.meshid) { op.meshid = args.meshid; } else if (args.group) { op.meshname = args.group; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => ((args.meshid != null) ? args.meshid : args.group)
    },
    {
        name: 'editdevicegroup',
        description: 'Change a device group named by id or name: rename it, set or clear its description, set its flags and consent options, and set invite codes with an optional background-only or interactive-only mode.',
        family: 'admin',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Device group name.' },
            { name: 'name', type: 'string', required: false, description: 'New device group name.' },
            { name: 'desc', type: 'string', required: false, description: 'New description; an empty string clears it.' },
            { name: 'flags', type: 'number', required: false, description: 'Device group flags: 1 auto-remove device on disconnect, 2 sync hostname; 0 for none.' },
            { name: 'consent', type: 'number', required: false, description: 'User consent flags: 1 desktop notify, 2 terminal notify, 4 files notify, 8 desktop prompt, 16 terminal prompt, 32 files prompt, 64 desktop toolbar; 0 for none.' },
            { name: 'invitecodes', type: 'string', required: false, description: 'Comma separated invite codes to set.' },
            { name: 'backgroundonly', type: 'boolean', required: false, description: 'With invitecodes, install the agent in the background only.' },
            { name: 'interactiveonly', type: 'boolean', required: false, description: 'With invitecodes, run the agent on demand only.' }
        ],
        auth: { user: true, rights: [] },
        cli: {
            name: 'editdevicegroup',
            format: formatActionResult,
            checks: [
                { anyOf: ['meshid', 'group'], message: "Device group identifier missing, use --id '[groupid]' or --group [groupname]" }
            ]
        },
        mcp: { name: 'mesh_edit_device_group' },
        protocol: {
            action: 'editmesh',
            params: (args) => {
                requireDeviceGroup(args);
                const op = {};
                if (args.meshid) { op.meshid = args.meshid; } else if (args.group) { op.meshidname = args.group; }
                if ((typeof args.name == 'string') && (args.name != '')) { op.meshname = args.name; }
                if (args.desc != null) { op.desc = args.desc; }
                if (args.invitecodes != null) {
                    const codes = String(args.invitecodes).split(',').filter((code) => code.length > 0);
                    if (codes.length > 0) {
                        op.invite = { codes: codes, flags: 0 };
                        if (args.backgroundonly === true) { op.invite.flags = 2; }
                        else if (args.interactiveonly === true) { op.invite.flags = 1; }
                    }
                }
                if (args.flags != null) { op.flags = parseInt(args.flags, 10); }
                if (args.consent != null) { op.consent = parseInt(args.consent, 10); }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => ((args.meshid != null) ? args.meshid : args.group)
    },
    {
        name: 'broadcast',
        description: 'Display a message to every logged in user account, or to a single account when user is set. Requires account administration rights on the server.',
        family: 'device',
        args: [
            { name: 'msg', type: 'string', required: true, description: 'Message to display.' },
            { name: 'user', type: 'string', required: false, description: 'Send the message to this user account (user//...) instead of every logged in user.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'broadcast',
            format: formatActionResult,
            checks: [
                { arg: 'msg', message: 'Message missing, use --msg [message]' }
            ]
        },
        mcp: { name: 'mesh_broadcast' },
        protocol: {
            action: 'userbroadcast',
            params: (args) => {
                const op = { msg: args.msg };
                if (args.user) { op.userid = args.user; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => ((args.user != null) ? args.user : 'all')
    },
    {
        name: 'showevents',
        description: 'Report the recent server events of the authenticated account as JSON, optionally filtered to a comma separated list of event actions. The CLI streams events until interrupted; a request/response bridge returns the server\'s snapshot of the same events instead.',
        family: 'inspection',
        args: [
            { name: 'filter', type: 'string', required: false, description: 'Comma separated event action names to include, for example nodeconnect,changenode. Default all events.' }
        ],
        auth: { user: true, rights: [] },
        cli: { name: 'showevents' },
        mcp: { name: 'mesh_show_events' },
        protocol: { action: 'events', params: () => ({}), matchAction: true },
        format: formatShownEvents,
        target: (args) => ((args.filter != null) ? args.filter : 'all')
    },
    {
        name: 'addusertodevicegroup',
        description: 'Grant a user account permissions on a device group. The per-group rights are the sum of the selected flags; fullrights grants every right.',
        family: 'admin',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Device group name.' },
            { name: 'userid', type: 'string', required: true, description: 'User account id (user//...).' },
            { name: 'fullrights', type: 'boolean', required: false, description: 'Grant full rights over this device group.' },
            { name: 'editgroup', type: 'boolean', required: false, description: 'Allow editing group information.' },
            { name: 'manageusers', type: 'boolean', required: false, description: 'Allow adding and removing users.' },
            { name: 'managedevices', type: 'boolean', required: false, description: 'Allow editing device information.' },
            { name: 'remotecontrol', type: 'boolean', required: false, description: 'Allow remote control operations.' },
            { name: 'agentconsole', type: 'boolean', required: false, description: 'Allow agent console operations.' },
            { name: 'serverfiles', type: 'boolean', required: false, description: 'Allow access to group server files.' },
            { name: 'wakedevices', type: 'boolean', required: false, description: 'Allow device wake operations.' },
            { name: 'notes', type: 'boolean', required: false, description: 'Allow setting device notes.' },
            { name: 'desktopviewonly', type: 'boolean', required: false, description: 'Restrict the desktop to view only.' },
            { name: 'noterminal', type: 'boolean', required: false, description: 'Deny terminal access.' },
            { name: 'nofiles', type: 'boolean', required: false, description: 'Deny file access.' },
            { name: 'noamt', type: 'boolean', required: false, description: 'Deny Intel AMT access.' },
            { name: 'limiteddesktop', type: 'boolean', required: false, description: 'Restrict desktop input.' },
            { name: 'limitedevents', type: 'boolean', required: false, description: 'Limit event visibility.' },
            { name: 'chatnotify', type: 'boolean', required: false, description: 'Allow chat and notifications.' },
            { name: 'uninstall', type: 'boolean', required: false, description: 'Allow uninstalling the agent.' },
            { name: 'noregistry', type: 'boolean', required: false, description: 'Deny registry access.' },
            { name: 'nosoftware', type: 'boolean', required: false, description: 'Deny software access.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'addusertodevicegroup',
            format: formatActionResult,
            checks: [
                { anyOf: ['meshid', 'group'], message: "Device group identifier missing, use --id '[groupid]' or --group [groupname]" },
                { arg: 'userid', message: 'Add user to group missing useid, use --userid [userid]' }
            ]
        },
        mcp: { name: 'mesh_add_user_to_device_group' },
        protocol: {
            action: 'addmeshuser',
            params: (args) => {
                requireDeviceGroup(args);
                const op = { userids: [args.userid], meshadmin: deviceGroupRights(args) };
                if (args.meshid) { op.meshid = args.meshid; } else if (args.group) { op.meshname = args.group; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.userid
    },
    {
        name: 'removeuserfromdevicegroup',
        description: 'Remove a user account from a device group, named by group id or group name.',
        family: 'admin',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Device group name.' },
            { name: 'userid', type: 'string', required: true, description: 'User account id (user//...).' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'removeuserfromdevicegroup',
            format: formatActionResult,
            checks: [
                { anyOf: ['meshid', 'group'], message: "Device group identifier missing, use --id '[groupid]' or --group [groupname]" },
                { arg: 'userid', message: 'Remove user from group missing useid, use --userid [userid]' }
            ]
        },
        mcp: { name: 'mesh_remove_user_from_device_group' },
        protocol: {
            action: 'removemeshuser',
            params: (args) => {
                requireDeviceGroup(args);
                const op = { userid: args.userid };
                if (args.meshid) { op.meshid = args.meshid; } else if (args.group) { op.meshname = args.group; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.userid
    },
    {
        name: 'addusertodevice',
        description: 'Grant a user account permissions on a single device. The device rights are the sum of the selected flags; fullrights grants the standard remote device rights.',
        family: 'admin',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...).' },
            { name: 'userid', type: 'string', required: true, description: 'User account id (user//...).' },
            { name: 'fullrights', type: 'boolean', required: false, description: 'Grant the standard full remote device rights.' },
            { name: 'remotecontrol', type: 'boolean', required: false, description: 'Allow remote control operations.' },
            { name: 'agentconsole', type: 'boolean', required: false, description: 'Allow agent console operations.' },
            { name: 'serverfiles', type: 'boolean', required: false, description: 'Allow file access.' },
            { name: 'wakedevices', type: 'boolean', required: false, description: 'Allow device wake operations.' },
            { name: 'notes', type: 'boolean', required: false, description: 'Allow setting device notes.' },
            { name: 'desktopviewonly', type: 'boolean', required: false, description: 'Restrict the desktop to view only.' },
            { name: 'noterminal', type: 'boolean', required: false, description: 'Deny terminal access.' },
            { name: 'nofiles', type: 'boolean', required: false, description: 'Deny file access.' },
            { name: 'noamt', type: 'boolean', required: false, description: 'Deny Intel AMT access.' },
            { name: 'limiteddesktop', type: 'boolean', required: false, description: 'Restrict desktop input.' },
            { name: 'limitedevents', type: 'boolean', required: false, description: 'Limit event visibility.' },
            { name: 'chatnotify', type: 'boolean', required: false, description: 'Allow chat and notifications.' },
            { name: 'uninstall', type: 'boolean', required: false, description: 'Allow uninstalling the agent.' },
            { name: 'noregistry', type: 'boolean', required: false, description: 'Deny registry access.' },
            { name: 'nosoftware', type: 'boolean', required: false, description: 'Deny software access.' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'addusertodevice',
            format: formatActionResult,
            checks: [
                { arg: 'userid', message: 'Add user to device missing userid, use --userid [userid]' },
                { arg: 'id', message: "Add user to device missing device id, use --id '[deviceid]'" }
            ]
        },
        mcp: { name: 'mesh_add_user_to_device' },
        protocol: {
            action: 'adddeviceuser',
            params: (args) => ({ nodeid: args.id, usernames: [args.userid], rights: deviceRights(args) })
        },
        format: formatActionResult,
        target: (args) => args.userid
    },
    {
        name: 'removeuserfromdevice',
        description: 'Remove a user account from a single device.',
        family: 'admin',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...).' },
            { name: 'userid', type: 'string', required: true, description: 'User account id (user//...).' }
        ],
        auth: { user: true, rights: ['manageusers'] },
        cli: {
            name: 'removeuserfromdevice',
            format: formatActionResult,
            checks: [
                { arg: 'userid', message: 'Remove user from device missing userid, use --userid [userid]' },
                { arg: 'id', message: "Remove user from device missing device id, use --id '[deviceid]'" }
            ]
        },
        mcp: { name: 'mesh_remove_user_from_device' },
        protocol: {
            action: 'adddeviceuser',
            params: (args) => ({ nodeid: args.id, usernames: [args.userid], rights: 0, remove: true })
        },
        format: formatActionResult,
        target: (args) => args.userid
    },
    {
        name: 'sendinviteemail',
        description: 'Send an agent installation invitation email for a device group, named by group id or group name, to one email address, with an optional recipient name and message.',
        family: 'device',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Device group name.' },
            { name: 'email', type: 'string', required: true, description: 'Email address to send the invitation to.' },
            { name: 'name', type: 'string', required: false, description: 'Recipient name included in the email.' },
            { name: 'message', type: 'string', required: false, description: 'Message included in the email.' }
        ],
        auth: { user: true, rights: [] },
        cli: {
            name: 'sendinviteemail',
            format: formatActionResult,
            checks: [
                { anyOf: ['meshid', 'group'], message: 'Device group identifier missing, use --id \'[groupid]\' or --group [groupname]' },
                { arg: 'email', message: 'Device email is missing, use --email [email]' }
            ]
        },
        mcp: { name: 'mesh_send_invite_email' },
        protocol: {
            action: 'inviteAgent',
            params: (args) => {
                requireDeviceGroup(args);
                const op = { email: args.email, name: '', os: '0' };
                if (args.meshid) { op.meshid = args.meshid; } else if (args.group) { op.meshname = args.group; }
                if (args.name) { op.name = args.name; }
                if (args.message) { op.msg = args.message; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => ((args.meshid != null) ? args.meshid : args.group)
    },
    {
        name: 'generateinvitelink',
        description: 'Create an agent installation invitation link for a device group, named by group id or group name, valid for a number of hours or forever with 0, and return the URL.',
        family: 'device',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Device group name.' },
            { name: 'hours', type: 'number', required: true, description: 'Validity period in hours, or 0 for an unlimited link.' },
            { name: 'flags', type: 'number', required: false, description: 'Link mode: 0 interactive and background, 1 interactive only, 2 background only.' }
        ],
        auth: { user: true, rights: [] },
        cli: {
            name: 'generateinvitelink',
            format: formatInviteLink,
            checks: [
                { anyOf: ['meshid', 'group'], message: 'Device group identifier missing, use --id \'[groupid]\' or --group [groupname]' },
                { arg: 'hours', message: 'Invitation validity period missing, use --hours [hours]' }
            ]
        },
        mcp: { name: 'mesh_generate_invite_link' },
        protocol: {
            action: 'createInviteLink',
            params: (args) => {
                requireDeviceGroup(args);
                const op = { expire: args.hours, flags: 0 };
                if (args.meshid) { op.meshid = args.meshid; } else if (args.group) { op.meshname = args.group; }
                if (args.flags) { op.flags = args.flags; }
                return op;
            }
        },
        format: formatInviteLink,
        target: (args) => ((args.meshid != null) ? args.meshid : args.group)
    },
    {
        name: 'config',
        description: 'Show or change the local config.json file of the bridge host, as the meshctrl config command does: show the file, list the non-default domains, add or remove a domain. The CLI also accepts free-form domain value flags, which a fixed tool schema cannot express, so only the operation flags are declared here.',
        family: 'local',
        args: [
            { name: 'show', type: 'boolean', required: false, description: 'Return the config.json file as JSON.' },
            { name: 'listdomains', type: 'boolean', required: false, description: 'List the non-default domains, one per line.' },
            { name: 'adddomain', type: 'string', required: false, description: 'Add a domain with this name.' },
            { name: 'removedomain', type: 'string', required: false, description: 'Remove the domain with this name.' },
            { name: 'settodomain', type: 'string', required: false, description: 'Select a domain for value changes; without the CLI free-form value flags this performs no change.' },
            { name: 'removefromdomain', type: 'string', required: false, description: 'Remove values from a domain; without the CLI free-form value flags this performs no change.' }
        ],
        auth: { user: true, rights: [] },
        cli: { name: 'config' },
        mcp: { name: 'mesh_config' },
        protocol: { local: (args) => readConfig(args) },
        format: formatConfig,
        target: configTarget
    },
    {
        name: 'movetodevicegroup',
        description: 'Move a device to another device group, named by group id or group name.',
        family: 'device',
        args: [
            { name: 'meshid', type: 'string', required: false, cli: 'id', description: 'Destination device group id (mesh//...).' },
            { name: 'group', type: 'string', required: false, description: 'Destination device group name.' },
            { name: 'devid', type: 'string', required: true, description: 'Device id (node//...) to move.' }
        ],
        auth: { user: true, rights: ['managecomputers', 'editmesh'] },
        cli: {
            name: 'movetodevicegroup',
            format: formatActionResult,
            checks: [
                { anyOf: ['meshid', 'group'], message: 'Device group identifier missing, use --id \'[groupid]\' or --group [groupname]' },
                { arg: 'devid', message: 'Device identifier missing, use --devid \'[deviceid]\'' }
            ]
        },
        mcp: { name: 'mesh_move_to_device_group' },
        protocol: {
            action: 'changeDeviceMesh',
            params: (args) => {
                requireDeviceGroup(args);
                const op = { nodeids: [args.devid] };
                if (args.meshid) { op.meshid = args.meshid; } else if (args.group) { op.meshname = args.group; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.devid
    },
    {
        name: 'deviceinfo',
        description: 'Report detailed information about one device as JSON: the node record, the last connection record, agent system information and network interfaces. System and network sections are omitted when the device is offline.',
        family: 'inspection',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' }
        ],
        auth: { user: true, rights: [] },
        cli: {
            name: 'deviceinfo',
            format: cliDeviceInfo,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" }
            ]
        },
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
    {
        name: 'removedevice',
        description: 'Delete a device record and its stored data from the server, requires uninstall rights on the device.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...).' }
        ],
        auth: { user: true, rights: ['uninstall'] },
        cli: {
            name: 'removedevice',
            format: formatActionResult,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" }
            ]
        },
        mcp: { name: 'mesh_remove_device' },
        protocol: {
            action: 'removedevices',
            params: (args) => ({ nodeids: [args.id] })
        },
        format: formatActionResult,
        target: (args) => args.id
    },
    {
        name: 'editdevice',
        description: 'Change a device name, description, tags, icon or consent flags. Adding or removing tags reads the device first so the existing tags are preserved.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...).' },
            { name: 'name', type: 'string', required: false, description: 'New device name.' },
            { name: 'desc', type: 'string', required: false, description: 'New device description.' },
            { name: 'tags', type: 'string', required: false, description: 'Comma separated tags that replace all existing tags.' },
            { name: 'addtag', type: 'string', required: false, description: 'Comma separated tags to add to the existing tags.' },
            { name: 'removetag', type: 'string', required: false, description: 'Comma separated tags to remove from the existing tags.' },
            { name: 'icon', type: 'number', required: false, description: 'Device icon number, 1 to 8.' },
            { name: 'consent', type: 'number', required: false, description: 'User consent flags: the sum of 1 desktop notify, 2 terminal notify, 4 files notify, 8 desktop prompt, 16 terminal prompt, 32 files prompt, 64 desktop privacy bar.' }
        ],
        auth: { user: true, rights: ['managecomputers'] },
        cli: { name: 'editdevice' },
        mcp: { name: 'mesh_edit_device' },
        protocol: [
            {
                action: (args) => ((args.addtag || args.removetag) ? 'nodes' : 'changedevice'),
                params: (args) => ((args.addtag || args.removetag) ? { id: args.id } : editDeviceParams(args, null)),
                follow: (response, args) => {
                    if (!args.addtag && !args.removetag) { return []; }
                    const node = findNode(response.nodes, args.id);
                    if (node == null) { throw new Error('Node not found.'); }
                    return [{ action: 'changedevice', params: () => editDeviceParams(args, Array.isArray(node.tags) ? node.tags : []) }];
                }
            }
        ],
        format: formatDeviceChange,
        target: (args) => args.id
    },
    {
        name: 'addlocaldevice',
        description: 'Add a local (agent-less) device entry to a device group, with its name, hostname and optional device type.',
        family: 'device',
        args: [
            { name: 'meshid', type: 'string', required: true, cli: 'id', description: 'Device group id (mesh//...).' },
            { name: 'devicename', type: 'string', required: true, description: 'Name of the new device.' },
            { name: 'hostname', type: 'string', required: true, description: 'Device hostname or IP address.' },
            { name: 'type', type: 'number', required: false, description: 'Device type: 4 Windows RDP (default), 6 Linux SSH/SCP/VNC, 29 macOS SSH/SCP/VNC.' }
        ],
        auth: { user: true, rights: ['managecomputers'] },
        cli: {
            name: 'addlocaldevice',
            format: formatActionResult,
            checks: [
                { arg: 'meshid', message: "Missing device id, use --id '[deviceid]'" },
                { arg: 'devicename', message: 'Missing devicename, use --devicename [devicename]' },
                { arg: 'hostname', message: 'Missing hostname, use --hostname [hostname]' }
            ]
        },
        mcp: { name: 'mesh_add_local_device' },
        protocol: {
            action: 'addlocaldevice',
            params: (args) => {
                const op = { type: 4, meshid: args.meshid, devicename: args.devicename, hostname: args.hostname };
                if (args.type) { op.type = args.type; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.meshid
    },
    {
        name: 'addamtdevice',
        description: 'Add an Intel AMT device entry to an Intel AMT device group, with its name, hostname and AMT credentials; TLS can be turned off for the connection.',
        family: 'device',
        args: [
            { name: 'meshid', type: 'string', required: true, cli: 'id', description: 'Intel AMT device group id (mesh//...).' },
            { name: 'devicename', type: 'string', required: true, description: 'Name of the new device.' },
            { name: 'hostname', type: 'string', required: true, description: 'Device hostname or IP address.' },
            { name: 'user', type: 'string', required: true, description: 'Intel AMT username.' },
            { name: 'pass', type: 'string', required: true, description: 'Intel AMT password.' },
            { name: 'notls', type: 'boolean', required: false, description: 'Connect without TLS security.' }
        ],
        auth: { user: true, rights: ['managecomputers'] },
        cli: {
            name: 'addamtdevice',
            format: formatActionResult,
            checks: [
                { arg: 'meshid', message: "Missing device id, use --id '[deviceid]'" },
                { arg: 'devicename', message: 'Missing devicename, use --devicename [devicename]' },
                { arg: 'hostname', message: 'Missing hostname, use --hostname [hostname]' },
                { arg: 'user', message: 'Missing user, use --user [user]' },
                { arg: 'pass', message: 'Missing pass, use --pass [pass]' }
            ]
        },
        mcp: { name: 'mesh_add_amt_device' },
        protocol: {
            action: 'addamtdevice',
            params: (args) => {
                const op = { amttls: 1, meshid: args.meshid, devicename: args.devicename, hostname: args.hostname, amtusername: args.user, amtpassword: args.pass };
                if (args.notls) { op.amttls = 0; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.meshid
    },
    {
        name: 'addusergroup',
        description: 'Create a new user group with an optional description, only through an account with user group administration rights.',
        family: 'admin',
        args: [
            { name: 'name', type: 'string', required: true, description: 'Name of the user group.' },
            { name: 'desc', type: 'string', required: false, description: 'User group description.' },
            { name: 'domain', type: 'string', required: false, description: 'User group domain, only for cross-domain administrators.' }
        ],
        auth: { user: true, rights: ['usergroups'] },
        cli: {
            name: 'addusergroup',
            format: formatActionResult,
            checks: [
                { arg: 'name', message: 'New user group name missing, use --name [name]' }
            ]
        },
        mcp: { name: 'mesh_add_user_group' },
        protocol: {
            action: 'createusergroup',
            params: (args) => {
                const op = { name: args.name };
                if (args.desc != null) { op.desc = args.desc; }
                if (args.domain) { op.domain = args.domain; }
                return op;
            }
        },
        format: formatActionResult,
        target: (args) => args.name
    },
    {
        name: 'listusergroups',
        description: 'List user groups visible to the authenticated account, as JSON, including each group\'s linked users, device groups and devices.',
        family: 'inspection',
        args: [],
        auth: { user: true, rights: ['manageusers'] },
        cli: { name: 'listusergroups', format: cliUserGroups },
        mcp: { name: 'mesh_list_user_groups' },
        protocol: { action: 'usergroups', params: () => ({}) },
        format: formatUserGroups,
        target: null
    },
    {
        name: 'removeusergroup',
        description: 'Delete a user group, named by its user group id.',
        family: 'admin',
        args: [
            { name: 'groupid', type: 'string', required: true, description: 'User group id (ugrp//...).' },
            { name: 'domain', type: 'string', required: false, description: 'User group domain, only for cross-domain administrators.' }
        ],
        auth: { user: true, rights: ['usergroups'] },
        cli: {
            name: 'removeusergroup',
            format: formatActionResult,
            checks: [
                { arg: 'groupid', message: "Remove user group id missing, use --groupid '[id]'" }
            ]
        },
        mcp: { name: 'mesh_remove_user_group' },
        protocol: {
            action: 'deleteusergroup',
            params: (args) => ({ ugrpid: completeUserGroupId(args.groupid, args.domain) })
        },
        format: formatActionResult,
        target: (args) => args.groupid
    },
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
        cli: {
            name: 'runcommand',
            format: cliRunCommand,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" },
                { arg: 'run', message: 'Missing run, use --run "command"' }
            ]
        },
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
    omitted('upload', 'Upload a file to a remote device. Deliberately out of scope: the bridge specification excludes file transfer, so this command keeps its CLI surface but has no tool.', 'device'),
    omitted('download', 'Download a file from a remote device. Deliberately out of scope: the bridge specification excludes file transfer, so this command keeps its CLI surface but has no tool.', 'device'),
    {
        name: 'deviceopenurl',
        description: 'Open a URL in the default browser on a remote device. The server acknowledges routing the request; the device does not confirm that the page opened.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device id (node//...) or a unique part of it.' },
            { name: 'openurl', type: 'string', required: true, description: 'URL to open on the remote device.' }
        ],
        auth: { user: true, rights: ['remotecontrol'] },
        cli: {
            name: 'deviceopenurl',
            format: cliResult,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" },
                { arg: 'openurl', message: 'Remote URL, use --openurl [url] specify the link to open.' }
            ]
        },
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
        cli: {
            name: 'devicemessage',
            format: cliResult,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" },
                { arg: 'msg', message: 'Remote message, use --msg "[message]" specify a remote message.' }
            ]
        },
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
        cli: {
            name: 'devicetoast',
            format: cliResult,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" },
                { arg: 'msg', message: 'Remote message, use --msg "[message]" specify a remote message.' }
            ]
        },
        mcp: { name: 'mesh_device_toast' },
        protocol: { action: 'toast', params: (args) => ({ nodeids: [args.id], title: (args.title ? args.title : 'MeshCentral'), msg: args.msg }) },
        format: () => 'Toast notification sent to the device.',
        target: (args) => args.id
    },
    {
        name: 'addtousergroup',
        description: 'Add a user account (user//...), device group (mesh//...) or device (node//...) to a user group, with optional device group or device rights.',
        family: 'admin',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Identifier to add: user//... adds a user account, mesh//... adds a device group, node//... adds a device.' },
            { name: 'userid', type: 'string', required: false, description: 'User account id to add, the legacy alternative to a user// id.' },
            { name: 'meshid', type: 'string', required: false, description: 'Device group id to add, the legacy alternative to a mesh// id.' },
            { name: 'nodeid', type: 'string', required: false, description: 'Device id to add, the legacy alternative to a node// id.' },
            { name: 'groupid', type: 'string', required: true, description: 'User group id (ugrp//...).' },
            { name: 'rights', type: 'number', required: false, description: 'Rights granted for a device group or device, as a number such as 4294967295 for full administrator.' }
        ],
        auth: { user: true, rights: ['usergroups'] },
        cli: {
            name: 'addtousergroup',
            format: formatActionResult,
            checks: [
                { arg: 'groupid', message: "Group id missing, use --groupid '[id]'" },
                { test: (args) => (args.id != null) || (args.userid != null) || (args.meshid != null) || (args.nodeid != null), message: 'Missing identifier to add, use --id [id]' }
            ]
        },
        mcp: { name: 'mesh_add_to_user_group' },
        protocol: {
            action: (args) => membershipAction(args, true),
            params: addToUserGroupParams
        },
        format: formatActionResult,
        target: (args) => args.id
    },
    {
        name: 'removefromusergroup',
        description: 'Remove a user account (user//...), device group (mesh//...) or device (node//...) from a user group.',
        family: 'admin',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Identifier to remove: user//..., mesh//... or node//....' },
            { name: 'userid', type: 'string', required: false, description: 'User account id to remove, the legacy alternative to a user// id.' },
            { name: 'meshid', type: 'string', required: false, description: 'Device group id to remove, the legacy alternative to a mesh// id.' },
            { name: 'nodeid', type: 'string', required: false, description: 'Device id to remove, the legacy alternative to a node// id.' },
            { name: 'groupid', type: 'string', required: true, description: 'User group id (ugrp//...).' }
        ],
        auth: { user: true, rights: ['usergroups'] },
        cli: {
            name: 'removefromusergroup',
            format: formatActionResult,
            checks: [
                { arg: 'groupid', message: "Group id missing, use --groupid '[id]'" },
                { test: (args) => (args.id != null) || (args.userid != null) || (args.meshid != null) || (args.nodeid != null), message: 'Missing identifier to remove, use --id [id]' }
            ]
        },
        mcp: { name: 'mesh_remove_from_user_group' },
        protocol: {
            action: (args) => membershipAction(args, false),
            params: removeFromUserGroupParams
        },
        format: formatActionResult,
        target: (args) => args.id
    },
    {
        name: 'removeallusersfromusergroup',
        description: 'Remove every user account from a user group in one operation, leaving device groups and devices in place.',
        family: 'admin',
        args: [
            { name: 'groupid', type: 'string', required: true, description: 'User group id (ugrp//...).' },
            { name: 'domain', type: 'string', required: false, description: 'User group domain, only for cross-domain administrators.' }
        ],
        auth: { user: true, rights: ['usergroups'] },
        cli: {
            name: 'removeallusersfromusergroup',
            format: formatRemoveAllUsersFromUserGroup,
            checks: [
                { arg: 'groupid', message: "Group id missing, use --groupid '[id]'" }
            ]
        },
        mcp: { name: 'mesh_remove_all_users_from_user_group' },
        protocol: [
            {
                action: 'usergroups',
                byAction: true,
                params: () => ({}),
                follow: (response, args) => {
                    const ugrpid = completeUserGroupId(args.groupid, args.domain);
                    return userGroupUserIds(args.groupid, args.domain)(response).map((userid) => ({
                        action: 'removeuserfromusergroup',
                        params: () => ({ ugrpid: ugrpid, userid: userid })
                    }));
                }
            }
        ],
        format: formatRemoveAllUsersFromUserGroup,
        target: (args) => args.groupid
    },
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
        cli: {
            name: 'devicesharing',
            format: cliDeviceShares,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" },
                { test: (argv) => !((argv.daily != null) && (argv.weekly != null)), message: "Can't specify both --daily and --weekly at the same time." },
                { test: (argv) => (argv.add == null) || (argv.add.length > 0), message: 'Invalid guest name.' }
            ]
        },
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
        cli: {
            name: 'devicepower',
            format: cliPowerAction,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" }
            ]
        },
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
        cli: { name: 'indexagenterrorlog', format: cliAgentErrorLog },
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
        cli: {
            name: 'agentdownload',
            format: formatAgentDownload,
            checks: [
                { arg: 'type', message: 'Missing device type, use --type [agenttype]' },
                {
                    test: (argv) => (parseInt(argv.type) != null) && !isNaN(parseInt(argv.type)) && (parseInt(argv.type) >= 1) && (parseInt(argv.type) <= 11000),
                    message: 'Invalid agent type, must be a number.'
                },
                { arg: 'id', message: "Missing device id, use --id '[meshid]'" },
                { test: (argv) => (typeof argv.id == 'string') && (argv.id.length == 64), message: 'Invalid meshid.' }
            ]
        },
        mcp: { name: 'mesh_agent_download' },
        protocol: { method: 'downloadAgent', params: (args) => agentDownloadParams(args) },
        format: formatAgentDownload,
        target: (args) => args.id
    },
    {
        name: 'report',
        description: 'Create and show a CSV report: sessions, traffic, logins or database records. The period defaults to the last 24 hours, or the last week when grouped by day. The database report requires full administrator rights.',
        family: 'admin',
        args: [
            { name: 'type', type: 'string', required: true, description: 'Report type: sessions, traffic, logins or db.' },
            { name: 'start', type: 'string', required: false, description: 'Start of the report period, an ISO date-time; defaults to the last 24 hours, or the last week when grouped by day.' },
            { name: 'end', type: 'string', required: false, description: 'End of the report period, an ISO date-time; defaults to now.' },
            { name: 'groupby', type: 'string', required: false, description: 'How to group the results: user (default), day or device.' },
            { name: 'devicegroup', type: 'string', required: false, description: 'Restrict the report to this device group id (sessions report).' },
            { name: 'showtraffic', type: 'boolean', required: false, description: 'Add traffic columns to a sessions report.' }
        ],
        auth: { user: true, rights: [] },
        cli: {
            name: 'report',
            format: formatReport,
            checks: [
                { arg: 'type', message: "Missing report type, use --type '[reporttype]'" }
            ]
        },
        mcp: { name: 'mesh_report' },
        protocol: {
            action: 'report',
            byAction: true,
            params: (args) => {
                let reporttype = 1;
                if (args.type === 'traffic') { reporttype = 2; }
                else if (args.type === 'logins') { reporttype = 3; }
                else if (args.type === 'db') { reporttype = 4; }
                let groupby = 1;
                if (args.groupby === 'device') { groupby = 2; }
                else if (args.groupby === 'day') { groupby = 3; }
                const now = Math.round(new Date().getTime() / 1000);
                const start = (args.start != null)
                    ? Math.floor(Date.parse(args.start) / 1000)
                    : ((groupby === 3) ? now - (168 * 3600) : now - (24 * 3600));
                const end = (args.end != null) ? Math.floor(Date.parse(args.end) / 1000) : now;
                if (end <= start) { throw new Error('End time must be ahead of start time.'); }
                return {
                    type: reporttype,
                    groupBy: groupby,
                    devGroup: args.devicegroup || null,
                    start: start,
                    end: end,
                    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    tf: new Date().getTimezoneOffset(),
                    showTraffic: (typeof args.showtraffic != 'undefined'),
                    l: 'en'
                };
            }
        },
        format: formatReport,
        target: (args) => (args.devicegroup || args.type)
    },
    {
        name: 'grouptoast',
        description: 'Display a toast notification on every device in a device group, one request per device group. The server acknowledges routing the requests; the devices do not confirm that the toasts were shown.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device group id (mesh//...).' },
            { name: 'msg', type: 'string', required: true, description: 'Message to display.' },
            { name: 'title', type: 'string', required: false, description: 'Toast title, default "MeshCentral".' }
        ],
        auth: { user: true, rights: ['remotecontrol'] },
        cli: {
            name: 'grouptoast',
            format: cliGroupToast,
            checks: [
                { arg: 'id', message: "Missing device group id, use --id '[devicegroupid]'" },
                { arg: 'msg', message: 'Remote message, use --msg "[message]" specify a remote message.' }
            ]
        },
        mcp: { name: 'mesh_group_toast' },
        protocol: [
            {
                action: 'nodes',
                params: (args) => ({ meshid: args.id }),
                follow: (response, args) => {
                    const specs = [];
                    for (const nodeids of deviceIdsByGroup(response.nodes)) {
                        if (nodeids.length === 0) { continue; }
                        specs.push({
                            action: 'toast',
                            params: () => ({ nodeids: nodeids, title: (args.title ? args.title : 'MeshCentral'), msg: args.msg })
                        });
                    }
                    return specs;
                }
            }
        ],
        format: formatGroupToast,
        target: (args) => args.id
    },
    {
        name: 'groupmessage',
        description: 'Display a message box on every device in a device group, one request per device. The server acknowledges routing the requests; the devices do not confirm that the boxes were shown. A box closes after the timeout, or after the CLI default of two minutes.',
        family: 'device',
        args: [
            { name: 'id', type: 'string', required: true, description: 'Device group id (mesh//...).' },
            { name: 'msg', type: 'string', required: true, description: 'Message to display.' },
            { name: 'title', type: 'string', required: false, description: 'Message box title, default "MeshCentral".' },
            { name: 'timeout', type: 'number', required: false, description: 'Milliseconds before the message box vanishes; the CLI default is 120000.' }
        ],
        auth: { user: true, rights: ['remotecontrol'] },
        cli: {
            name: 'groupmessage',
            format: cliGroupMessage,
            checks: [
                { arg: 'id', message: "Missing device group id, use --id '[devicegroupid]'" },
                { arg: 'msg', message: 'Remote message, use --msg "[message]" specify a remote message.' }
            ]
        },
        mcp: { name: 'mesh_group_message' },
        protocol: [
            {
                action: 'nodes',
                params: (args) => ({ meshid: args.id }),
                follow: (response, args) => {
                    const specs = [];
                    for (const node of flattenNodes(response.nodes)) {
                        specs.push({
                            action: 'msg',
                            params: () => ({ type: 'messagebox', nodeid: node.id, title: (args.title ? args.title : 'MeshCentral'), msg: args.msg, timeout: (args.timeout ? args.timeout : 120000) })
                        });
                    }
                    return specs;
                }
            }
        ],
        format: formatGroupMessage,
        target: (args) => args.id
    },
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
        cli: {
            name: 'webrelay',
            format: cliWebRelay,
            checks: [
                { arg: 'id', message: "Missing device id, use --id '[deviceid]'" },
                { arg: 'type', message: 'Missing protocol type, use --type [http,https]' }
            ]
        },
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
    mcpCommands: mcpCommands
};
