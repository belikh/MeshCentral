'use strict';

/**
* @description MeshCentral tools for the MCP bridge.
*
* Every tool is declared as a registry entry (name, description, input schema,
* handler). Handlers hold no protocol knowledge: they validate their own
* semantics, call the injected MeshCentral client and shape the result into
* MCP content. Server errors are rethrown verbatim so the registry can surface
* them unchanged.
*
* Later tickets extend this module (or register their own tool groups) with the
* desktop capture/control tools and the command catalogue tools.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { z } = require('zod');
const { textResult } = require('./mcp-tool-registry.js');

/** Replace quotes and line breaks so one device stays on one text line. */
function escapeField(value) {
    return String((value != null) ? value : '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
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

/** Ask the server for devices and return them as text content. */
async function listDevices(client, args) {
    const params = {};
    if (args.meshid != null) { params.meshid = args.meshid; }

    const response = await client.request('nodes', params);
    if (response == null) { throw new Error('The MeshCentral server returned no response for the nodes action.'); }
    if ((response.result != null) && (response.result !== 'ok')) { throw new Error(String(response.result)); }

    let devices = flattenNodes(response.nodes);
    if (args.filter != null) {
        const needle = String(args.filter).toLowerCase();
        devices = devices.filter((device) =>
            String(device.id).toLowerCase().includes(needle) || String(device.name).toLowerCase().includes(needle));
    }
    return textResult(formatDeviceList(devices));
}

/**
* Declare the MeshCentral tools on a registry.
*
* options.client  A connected MeshCentralClient (or a compatible object).
*/
function registerMeshTools(registry, options) {
    options = options || {};
    if (options.client == null) { throw new Error('registerMeshTools requires a client.'); }

    registry.register({
        name: 'mesh_list_devices',
        description: 'List devices known to the MeshCentral server, one per line, with the device id, name, device group, connection and power state. Optionally restrict to a single device group with meshid, or narrow the result with a case-insensitive filter on device name or id.',
        inputSchema: {
            meshid: z.string().optional().describe('Restrict the listing to this device group id (mesh//...).'),
            filter: z.string().optional().describe('Case-insensitive substring match on device name or device id.')
        },
        target: (args) => ((args.meshid != null) ? args.meshid : ((args.filter != null) ? args.filter : 'all')),
        handler: (args) => listDevices(options.client, args)
    });

    return registry;
}

module.exports = {
    registerMeshTools: registerMeshTools,
    listDevices: listDevices,
    flattenNodes: flattenNodes,
    formatDeviceList: formatDeviceList
};
