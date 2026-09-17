'use strict';

/**
 * @description MeshCentral tools for the MCP bridge, generated from the shared
 * command catalogue.
 *
 * One tool is registered for every catalogue entry that declares an MCP
 * surface. The tool name, description, input schema, argument validation,
 * protocol requests and result shaping all come from the entry; nothing is
 * hand written per tool. Handlers hold no protocol knowledge: they run the
 * declared requests through the injected client and hand the response to the
 * entry's formatter. Server errors are surfaced verbatim.
 *
 * Later tickets expose the device action and administrative command families
 * by extending their catalogue entries; this module does not change.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { z } = require('zod');
const { textResult } = require('./mcp-tool-registry.js');
const catalogue = require('./command-catalogue.js');

/** Build the validation schema for one declared catalogue argument. */
function argumentSchema(arg) {
    let schema = null;
    if (arg.type === 'number') {
        schema = z.coerce.number();
    } else if (arg.type === 'boolean') {
        schema = z.boolean();
    } else {
        schema = arg.required ? z.string().min(1) : z.string();
    }
    if (arg.description != null) { schema = schema.describe(arg.description); }
    return arg.required ? schema : schema.optional();
}

/**
* Build the registry input schema for a catalogue entry: a Zod object schema
* for a command with no arguments, a Zod raw shape otherwise.
*/
function inputSchemaFor(entry) {
    if ((entry.args == null) || (entry.args.length === 0)) { return z.object({}); }
    const shape = {};
    for (const arg of entry.args) { shape[arg.name] = argumentSchema(arg); }
    return shape;
}

/** True when a response carries a server result other than success. */
function isServerError(response) {
    return (response.result != null) && (response.result !== 'ok') && (response.result !== 'OK');
}

/**
* Execute the protocol mapping declared by a catalogue entry against a client.
* Resolves with the response (single request), the ordered response array
* (several requests) or the handshake value (from). Optional requests that
* fail resolve to null so commands can report partial data. Every other
* server error is thrown verbatim.
*/
async function executeProtocol(client, entry, args) {
    const protocol = entry.protocol;
    if (protocol == null) { throw new Error('The ' + entry.name + ' command has no protocol mapping.'); }

    if (!Array.isArray(protocol) && (protocol.from != null)) {
        const value = client[protocol.from];
        if (value == null) { throw new Error('No ' + protocol.from + ' is available from the connection handshake.'); }
        return value;
    }

    const specs = Array.isArray(protocol) ? protocol : [protocol];
    const responses = [];
    for (const spec of specs) {
        let response = null;
        try {
            response = await client.request(spec.action, (spec.params != null) ? spec.params(args) : {});
        } catch (error) {
            if (spec.optional) { responses.push(null); continue; }
            throw error;
        }
        if (response == null) {
            if (spec.optional) { responses.push(null); continue; }
            throw new Error('The MeshCentral server returned no response for the ' + spec.action + ' action.');
        }
        if (isServerError(response)) {
            if (spec.optional) { responses.push(null); continue; }
            throw new Error(String(response.result));
        }
        responses.push(response);
    }
    return Array.isArray(protocol) ? responses : responses[0];
}

/**
* Declare the catalogue tools on a registry.
*
* options.client  A connected MeshCentralClient (or a compatible object).
*/
function registerMeshTools(registry, options) {
    options = options || {};
    if (options.client == null) { throw new Error('registerMeshTools requires a client.'); }

    for (const entry of catalogue.mcpCommands()) {
        registry.register({
            name: entry.mcp.name,
            description: entry.description,
            inputSchema: inputSchemaFor(entry),
            target: entry.target,
            handler: async (args) => {
                const value = await executeProtocol(options.client, entry, args);
                return textResult(entry.format(value, args));
            }
        });
    }

    return registry;
}

module.exports = {
    registerMeshTools: registerMeshTools,
    executeProtocol: executeProtocol,
    inputSchemaFor: inputSchemaFor,
    flattenNodes: catalogue.flattenNodes,
    formatDeviceList: catalogue.formatDeviceList
};
