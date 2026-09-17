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
 * by extending their catalogue entries. A command whose protocol depends on
 * its arguments, whose server response carries no responseid, or which fans
 * out over a response declares that in the entry; the execution forms here
 * (control request, client method, local handler) are generic and stay
 * unchanged.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { z } = require('zod');
const { textResult } = require('./mcp-tool-registry.js');
const catalogue = require('./command-catalogue.js');
const { executeProtocol } = require('./protocol-executor.js');

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
    inputSchemaFor: inputSchemaFor
};
