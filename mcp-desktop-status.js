'use strict';

/**
 * @description The mesh_desktop_status MCP tool.
 *
 * The status tool reports whether a capture is currently possible for a device
 * before any session is attempted: device online state, the agent's desktop
 * capability, the account's desktop relay right and any cached session. It
 * never launches a relay session: it reads the node record and the connection
 * handshake, and peeks the session cache.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { z } = require('zod');
const { IMAGE_TYPES } = require('./desktopcapture.js');
const { textResult } = require('./mcp-tool-registry.js');
const { IMAGE_TYPE_NAMES } = require('./mcp-desktop-shared.js');

// The agent capability bit that advertises desktop capture support.
const AGENT_CAPS_DESKTOP = 1;
// Mesh rights that permit a desktop relay: remote control (8) or relay (0x200000).
const MESH_RIGHTS_DESKTOP = 0x00200008;
const SITE_RIGHTS_ADMIN = 0xFFFFFFFF;

/**
 * Resolve the account's desktop relay right from the connection handshake.
 * Returns true when the account can open a desktop relay, false when it
 * demonstrably cannot, and null when the handshake carries no userinfo to
 * judge from. Full site administrators hold the right without any links;
 * everyone else needs the remote control or relay right on the device's
 * device group or on the device itself.
 */

function resolveDesktopRight(userInfo, node) {
    if (userInfo == null) { return null; }
    const siteadmin = userInfo.siteadmin;
    if (siteadmin === SITE_RIGHTS_ADMIN) { return true; }
    const links = userInfo.links;
    if ((links == null) || (typeof links !== 'object')) { return false; }
    for (const key of [node.meshid, node.id]) {
        if (key == null) { continue; }
        const link = links[key];
        if (link == null) { continue; }
        if (link.rights === SITE_RIGHTS_ADMIN) { return true; }
        if ((typeof link.rights === 'number') && ((link.rights & MESH_RIGHTS_DESKTOP) !== 0)) { return true; }
    }
    return false;
}

/** Describe the encoding a cached session was opened with, or null. */
function sessionEncoding(capture) {
    const encoding = (capture != null) ? capture.encoding : null;
    if (encoding == null) { return null; }
    for (const name of IMAGE_TYPE_NAMES) {
        if (IMAGE_TYPES[name] === encoding.imageType) {
            return { imageType: name, quality: encoding.compression, scale: encoding.scaling };
        }
    }
    return null;
}

/**
 * Find one node in a nodes response by id, bare or partial, the way the
 * catalogue's deviceinfo entry does. Returns { node, meshid } or null.
 */
function findNode(nodes, deviceid) {
    if ((nodes == null) || (typeof nodes !== 'object')) { return null; }
    for (const meshid of Object.keys(nodes)) {
        const group = nodes[meshid];
        if (!Array.isArray(group)) { continue; }
        for (const node of group) {
            if ((node != null) && (String(node._id).indexOf(deviceid) >= 0)) { return { node, meshid }; }
        }
    }
    return null;
}

/** Compact offline check: connectivity bit 0 (agent) or 1 (CIRA). */
function isOnline(node) {
    return (Number(node.conn) || 0) !== 0;
}

/**
 * Report whether capturing a device's screen is currently possible.
 *
 * args.deviceid  Device id, bare or a full node id.
 *
 * options.client  Required. The connected MeshCentral client whose handshake
 *                 carries userInfo.
 * options.cache   Optional session cache to peek, never acquire. When absent,
 *                 session.cached is reported as false.
 * options.now     Clock in milliseconds, Date.now by default.
 *
 * Reads the device record through the client's nodes request and the account
 * rights from the handshake. Never launches a relay session. Resolves with a
 * text/JSON status report: 'ready' when capture can be attempted, 'blocked'
 * with per-check reasons when it demonstrably cannot, and 'unknown' when a
 * check cannot be evaluated (the account's rights are not in the handshake).
 */
async function desktopStatus(options, args) {
    options = options || {};
    const response = await options.client.request('nodes', {});
    const found = findNode((response != null) ? response.nodes : null, args.deviceid);
    if (found == null) {
        throw new Error('Invalid device id');
    }

    const node = found.node;
    const online = isOnline(node);
    const caps = (node.agent != null) && (typeof node.agent.caps === 'number') ? node.agent.caps : null;
    const desktopCapable = (caps == null) ? null : ((caps & AGENT_CAPS_DESKTOP) !== 0);
    const desktopRight = resolveDesktopRight(options.client.userInfo, { id: node._id, meshid: found.meshid });

    let entry = null;
    if (options.cache != null) { entry = options.cache.peek(args.deviceid); }
    const now = (typeof options.now === 'function') ? options.now() : Date.now();
    const session = {
        cached: entry != null,
        // A cached entry is at least a moment old; never report 0 and read as uncached.
        ageMs: (entry != null) ? Math.max(1, now - entry.lastUsed) : null,
        encoding: (entry != null) ? sessionEncoding(entry.capture) : null
    };

    const reasons = [];
    if (!online) { reasons.push('offline'); }
    if (desktopCapable === false) { reasons.push('desktop-unsupported'); }
    if (desktopRight === false) { reasons.push('missing-desktop-right'); }
    let status = (reasons.length > 0) ? 'blocked' : 'ready';
    if ((desktopRight == null) && (desktopCapable !== false) && online) {
        reasons.push('rights-unknown');
        status = 'unknown';
    }

    return textResult(JSON.stringify({
        status: status,
        reasons: reasons,
        device: { id: node._id, name: (node.name != null) ? node.name : null, meshid: found.meshid },
        online: online,
        agent: { desktop: desktopCapable, caps: caps },
        account: { desktopRight: desktopRight },
        session: session
    }, null, 2));
}

/**
 * Declare the status tool on a registry.
 *
 * options.client  A connected MeshCentralClient (or a compatible object).
 * options.cache   The DesktopSessionCache shared with the frames and input
 *                 tools; peeked, never acquired.
 * options.now     Clock in milliseconds, Date.now by default.
 */
function registerStatusTool(registry, options) {
    registry.register({
        name: 'mesh_desktop_status',
        description: 'Report whether capturing a device\'s screen is currently possible, without opening a desktop relay session. Reports the device online state, the agent\'s desktop capability from its capability bit, the account\'s desktop relay right from the connection handshake, and whether a cached desktop session exists (with its age and encoding). A status of ready means a capture can be attempted; blocked lists the failing checks in reasons; unknown means a check cannot be evaluated, such as missing handshake rights. The device id may be a bare id or a full node id (node//...). The account\'s desktop right and the server\'s consent, privacy and recording behaviour are unchanged.',
        inputSchema: {
            deviceid: z.string().min(1).describe('Device id of the machine to inspect, bare or a full node id (node//...).')
        },
        target: (args) => args.deviceid,
        handler: (args) => desktopStatus({ client: options.client, cache: options.cache, now: options.now }, args)
    });
}

module.exports = {
    registerStatusTool: registerStatusTool,
    desktopStatus: desktopStatus,
    resolveDesktopRight: resolveDesktopRight
};
