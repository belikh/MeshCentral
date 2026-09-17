'use strict';

/**
* @description MeshCentral MCP bridge over stdio.
*
* Launched by an MCP client as a subprocess, this server connects to a
* MeshCentral control server, registers the MeshCentral tools and serves them
* over the stdio transport. stdout carries the MCP protocol; every audit record
* and diagnostic goes to stderr. Credentials come from CLI flags or the
* environment and never travel through tool arguments; error output and audit
* records are redacted so credentials cannot leak into logs.
*
* Usage: node mcp-server.js [--url wss://server ...] (see usageText()).
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const minimist = require('minimist');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const { MeshCentralClient, ConfigurationError } = require('./meshcentral-client.js');
const { createToolRegistry } = require('./mcp-tool-registry.js');
const { registerMeshTools } = require('./mcp-tools.js');
const packageJson = require('./package.json');

const SERVER_NAME = 'meshcentral-mcp';
const DEFAULT_COMMAND_TIMEOUT = 30000;
const DEFAULT_CONNECT_TIMEOUT = 30000;
const CREDENTIAL_QUERY = /([?&](?:key|auth|token|password)=)[^&\s"']*/gi;

/** Remove credential values from any text bound for stderr or an audit record. */
function redact(text) {
    if (typeof text !== 'string') { return String(text); }
    return text.replace(CREDENTIAL_QUERY, '$1[redacted]');
}

function errorMessage(error) {
    if (error == null) { return 'Unknown error.'; }
    return (error.message != null) ? String(error.message) : String(error);
}

function copyString(config, key, flagValue, envValue) {
    const value = (flagValue !== undefined) ? flagValue : envValue;
    if ((value == null) || (value === true)) { return; }
    config[key] = String(value);
}

function copyTimeout(config, key, flag, flagValue, envValue) {
    const value = (flagValue !== undefined) ? flagValue : envValue;
    if (value == null) { return; }
    if (value === true) {
        throw new ConfigurationError('The --' + flag + ' flag requires a value in milliseconds.', 'EINVALIDCONFIG');
    }
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || (milliseconds <= 0) || (Math.floor(milliseconds) !== milliseconds)) {
        throw new ConfigurationError('Invalid --' + flag + ' value "' + value + '": expected a positive number of milliseconds.', 'EINVALIDCONFIG');
    }
    config[key] = milliseconds;
}

/**
* Build MeshCentral client options from CLI flags with environment fallbacks.
* Flags win over environment values. Returns { help, version, config }; the
* config only carries explicitly configured options, so client defaults apply
* to everything else. Throws ConfigurationError for invalid values.
*/
function parseConfig(argv, env) {
    argv = argv || [];
    env = env || {};
    const args = minimist(argv);
    const config = {};

    copyString(config, 'url', args.url, env.MESHCENTRAL_URL);
    copyString(config, 'user', args.loginuser, env.MESHCENTRAL_USER);
    if (args.loginpass === true) {
        throw new ConfigurationError('The --loginpass flag requires a value; the stdio bridge does not prompt for a password.', 'EINVALIDCONFIG');
    }
    copyString(config, 'password', args.loginpass, env.MESHCENTRAL_PASSWORD);
    copyString(config, 'token', args.token, env.MESHCENTRAL_TOKEN);
    copyString(config, 'loginKey', args.loginkey, env.MESHCENTRAL_LOGINKEY);
    copyString(config, 'loginKeyFile', args.loginkeyfile, env.MESHCENTRAL_LOGINKEYFILE);
    copyString(config, 'domain', args.logindomain, env.MESHCENTRAL_DOMAIN);
    copyString(config, 'proxy', args.proxy, env.MESHCENTRAL_PROXY);
    copyTimeout(config, 'commandTimeout', 'commandtimeout', args.commandtimeout, env.MESHCENTRAL_COMMAND_TIMEOUT);
    copyTimeout(config, 'connectTimeout', 'connecttimeout', args.connecttimeout, env.MESHCENTRAL_CONNECT_TIMEOUT);

    return { help: args.help === true, version: args.version === true, config: config };
}

/**
* Create the stderr audit sink. Every invocation produces one JSON line with
* the timestamp, tool, target, outcome, durationMs and denial/error reason.
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
*   version       Bridge version reported to MCP clients. Defaults to package.json.
*   now           Clock injected into the registry, for tests.
*   registerTools Optional function (registry, { client }) registering extra
*                 tool groups; later tickets add the desktop tools this way.
*
* Returns { client, registry, mcp, connect(transport?), close() }.
*/
function createMcpServer(options) {
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
    if (typeof options.registerTools === 'function') { options.registerTools(registry, { client: client }); }

    const mcp = new McpServer({ name: SERVER_NAME, version: options.version || packageJson.version });
    for (const tool of registry.list()) {
        mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args) => registry.call(tool.name, args));
    }

    return {
        client: client,
        registry: registry,
        mcp: mcp,
        connect: (transport) => mcp.connect(transport || new StdioServerTransport()),
        close: () => mcp.close()
    };
}

function usageText() {
    return [
        'Usage: meshcentral-mcp [options]',
        '',
        'Runs a stdio MCP server exposing MeshCentral as tools.',
        'stdout carries the MCP protocol; audit records and diagnostics go to stderr.',
        '',
        'Options:',
        '  --url [wss://server]        Server url (env MESHCENTRAL_URL)',
        '  --loginuser [username]      Login username, admin is default (env MESHCENTRAL_USER)',
        '  --loginpass [password]      Login password (env MESHCENTRAL_PASSWORD)',
        '  --token [number]            2nd factor authentication token (env MESHCENTRAL_TOKEN)',
        '  --loginkey [hex]            Server login key in hex (env MESHCENTRAL_LOGINKEY)',
        '  --loginkeyfile [file]       File containing the server login key in hex (env MESHCENTRAL_LOGINKEYFILE)',
        '  --logindomain [domainid]    Domain id, only used with a login key (env MESHCENTRAL_DOMAIN)',
        '  --proxy [http://proxy:123]  HTTP proxy (env MESHCENTRAL_PROXY)',
        '  --commandtimeout [ms]       Per-command timeout, default ' + DEFAULT_COMMAND_TIMEOUT + ' (env MESHCENTRAL_COMMAND_TIMEOUT)',
        '  --connecttimeout [ms]       Connection timeout, default ' + DEFAULT_CONNECT_TIMEOUT + ' (env MESHCENTRAL_CONNECT_TIMEOUT)',
        '  --help                      Show this help',
        '  --version                   Show the bridge version',
        ''
    ].join('\n');
}

/**
* Run the bridge until the MCP client disconnects or a signal arrives.
* Returns the process exit code. io.stderr is injectable for tests.
*/
async function main(argv, env, io) {
    const stderr = ((io != null) && (io.stderr != null)) ? io.stderr : process.stderr;
    const options = parseConfig(argv, env);
    if (options.help) { stderr.write(usageText()); return 0; }
    if (options.version) { stderr.write(packageJson.version + '\n'); return 0; }

    let client = null;
    try {
        client = new MeshCentralClient(options.config);
        await client.connect();
    } catch (error) {
        if (client != null) { try { await client.close(); } catch (ex) { } }
        stderr.write(SERVER_NAME + ': ' + redact(errorMessage(error)) + '\n');
        return 1;
    }

    const server = createMcpServer({ client: client });
    try {
        await server.connect(new StdioServerTransport());
    } catch (error) {
        try { await client.close(); } catch (ex) { }
        stderr.write(SERVER_NAME + ': ' + redact(errorMessage(error)) + '\n');
        return 1;
    }
    stderr.write(SERVER_NAME + ': connected to ' + redact(client.controlUrl) + '\n');

    return new Promise((resolve) => {
        let finished = false;
        const shutdown = (code) => {
            if (finished) { return; }
            finished = true;
            Promise.allSettled([server.close(), client.close()]).then(() => resolve(code));
        };
        process.once('SIGINT', () => shutdown(0));
        process.once('SIGTERM', () => shutdown(0));
        process.stdin.once('end', () => shutdown(0));
    });
}

if (require.main === module) {
    main(process.argv.slice(2), process.env).then((code) => {
        process.exitCode = code;
    }, (error) => {
        process.stderr.write(SERVER_NAME + ': ' + redact(errorMessage(error)) + '\n');
        process.exitCode = 1;
    });
}

module.exports = {
    SERVER_NAME: SERVER_NAME,
    parseConfig: parseConfig,
    createAuditLog: createAuditLog,
    createMcpServer: createMcpServer,
    usageText: usageText,
    redact: redact,
    main: main
};
