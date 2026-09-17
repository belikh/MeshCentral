'use strict';

/**
* @description Transport-neutral MeshCentral MCP bridge.
*
* Builds one MCP server around an injected MeshCentral client: the tool
* registry, the command tools generated from the shared catalogue, the desktop
* tools and the audit sink. Transports call the factory and connect their own
* transport to the returned server; no transport registers tools itself.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

const { ConfigurationError } = require('./meshcentral-client.js');
const { createToolRegistry } = require('./mcp-tool-registry.js');
const { registerMeshTools } = require('./mcp-tools.js');
const { registerDesktopTools } = require('./mcp-desktop-tools.js');
const { BRIDGE_VERSION, TOOL_SCHEMA_VERSION } = require('./mcp-version.js');

const SERVER_NAME = 'meshcentral-mcp';
const CREDENTIAL_QUERY = /([?&](?:key|auth|token|password)=)[^&\s"']*/gi;

/** Remove credential values from any text bound for a log or audit record. */
function redact(text) {
    if (typeof text !== 'string') { return String(text); }
    return text.replace(CREDENTIAL_QUERY, '$1[redacted]');
}

function errorMessage(error) {
    if (error == null) { return 'Unknown error.'; }
    return (error.message != null) ? String(error.message) : String(error);
}

/**
* Create the audit sink. Every invocation produces one JSON line with the
* timestamp, tool, target, outcome, durationMs and denial/error reason.
* Credential values are redacted before writing.
*
* Options: stream (default process.stderr), now (default () => new Date()).
*/
function createAuditLog(options) {
    options = options || {};
    const stream = options.stream || process.stderr;
    const now = (typeof options.now === 'function') ? options.now : () => new Date();
    return {
        record(entry) {
            entry = entry || {};
            const record = {
                timestamp: now().toISOString(),
                tool: (entry.tool != null) ? String(entry.tool) : null,
                target: (entry.target != null) ? redact(String(entry.target)) : null,
                outcome: (entry.outcome != null) ? String(entry.outcome) : null,
                durationMs: (entry.duration != null) ? entry.duration : null,
                reason: (entry.reason != null) ? redact(String(entry.reason)) : null
            };
            stream.write(JSON.stringify(record) + '\n');
        }
    };
}

/**
* Build the MCP server around an injected MeshCentral client.
*
* Options:
*   client        Required. A connected MeshCentralClient or compatible object.
*   audit         Audit sink with record(entry). Defaults to stderr.
*   version       Bridge version reported to MCP clients. Defaults to the
*                 version module.
*   now           Clock injected into the registry, for tests.
*   defaults      Desktop capture defaults ({ imageType, quality, scale })
*                 applied when a session is opened without the matching
*                 argument.
*   createCapture Capture factory for the desktop tools; defaults to the real
*                 DesktopCapture.
*   cache         Desktop session cache shared by the frames and input tools.
*   lifecycle     Process-like emitter carrying 'exit' for the default cache.
*   idleTimeout   Idle timeout for the default cache, in milliseconds.
*
* Returns { client, registry, mcp, connect(transport), close() }.
*/
function createBridgeServer(options) {
    options = options || {};
    const client = options.client;
    if (client == null) {
        throw new ConfigurationError('The MCP server requires a MeshCentral client instance.', 'ENOCLIENT');
    }

    const audit = options.audit || createAuditLog();
    const registry = createToolRegistry({
        onInvocation: (record) => audit.record(record),
        now: options.now
    });
    registerMeshTools(registry, { client: client });
    registerDesktopTools(registry, {
        client: client,
        defaults: options.defaults,
        createCapture: options.createCapture,
        cache: options.cache,
        lifecycle: options.lifecycle,
        idleTimeout: options.idleTimeout,
        now: options.now
    });

    const version = options.version || BRIDGE_VERSION;
    const mcp = new McpServer(
        { name: SERVER_NAME, version: version },
        { instructions: SERVER_NAME + ' ' + version + ' (tool schema ' + TOOL_SCHEMA_VERSION + ')' }
    );
    for (const tool of registry.list()) {
        mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args) => registry.call(tool.name, args));
    }

    return {
        client: client,
        registry: registry,
        mcp: mcp,
        connect: (transport) => {
            if (transport == null) { throw new ConfigurationError('The MCP server requires a transport to connect.', 'ENOTRANSPORT'); }
            return mcp.connect(transport);
        },
        close: () => mcp.close()
    };
}

module.exports = {
    SERVER_NAME: SERVER_NAME,
    createBridgeServer: createBridgeServer,
    createAuditLog: createAuditLog,
    redact: redact,
    errorMessage: errorMessage
};
