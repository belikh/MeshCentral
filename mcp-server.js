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
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const {
    MeshCentralClient,
    ConfigurationError,
    DEFAULT_COMMAND_TIMEOUT,
    DEFAULT_CONNECT_TIMEOUT
} = require('./meshcentral-client.js');
const {
    SERVER_NAME,
    createBridgeServer,
    createAuditLog,
    redact,
    errorMessage
} = require('./mcp-bridge.js');
const { BRIDGE_VERSION, TOOL_SCHEMA_VERSION } = require('./mcp-version.js');

const DEFAULT_IMAGE_TYPE = 'jpeg';
const IMAGE_TYPE_NAMES = ['jpeg', 'png', 'tiff', 'webp'];
const MIN_QUALITY = 0;
const MAX_QUALITY = 100;
const MIN_SCALE = 1;
const MAX_SCALE = 65535;

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

function copyImageType(config, key, flag, flagValue, envValue) {
    const value = (flagValue !== undefined) ? flagValue : envValue;
    if (value == null) { return; }
    if (value === true) {
        throw new ConfigurationError('The --' + flag + ' flag requires a value; one of ' + IMAGE_TYPE_NAMES.join(', ') + '.', 'EINVALIDCONFIG');
    }
    const name = String(value).toLowerCase();
    if (IMAGE_TYPE_NAMES.indexOf(name) < 0) {
        throw new ConfigurationError('Invalid --' + flag + ' value "' + value + '": expected one of ' + IMAGE_TYPE_NAMES.join(', ') + '.', 'EINVALIDCONFIG');
    }
    config[key] = name;
}

function copyBoundedInteger(config, key, flag, flagValue, envValue, minimum, maximum) {
    const value = (flagValue !== undefined) ? flagValue : envValue;
    if (value == null) { return; }
    if (value === true) {
        throw new ConfigurationError('The --' + flag + ' flag requires a value between ' + minimum + ' and ' + maximum + '.', 'EINVALIDCONFIG');
    }
    const number = Number(value);
    if (!Number.isInteger(number) || (number < minimum) || (number > maximum)) {
        throw new ConfigurationError('Invalid --' + flag + ' value "' + value + '": expected an integer between ' + minimum + ' and ' + maximum + '.', 'EINVALIDCONFIG');
    }
    config[key] = number;
}

/**
* Build MeshCentral client options from CLI flags with environment fallbacks.
* Flags win over environment values. Returns { help, version, config }; the
* config only carries explicitly configured options, so client defaults apply
* to everything else. Desktop capture defaults (defaultImageType,
* defaultQuality, defaultScale) ride in the same config and are applied by the
* desktop tools when a session is opened without the matching tool argument.
* Throws ConfigurationError for invalid values.
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
    copyImageType(config, 'defaultImageType', 'desktopimagetype', args.desktopimagetype, env.MESHCENTRAL_DESKTOP_IMAGETYPE);
    copyBoundedInteger(config, 'defaultQuality', 'desktopquality', args.desktopquality, env.MESHCENTRAL_DESKTOP_QUALITY, MIN_QUALITY, MAX_QUALITY);
    copyBoundedInteger(config, 'defaultScale', 'desktopscale', args.desktopscale, env.MESHCENTRAL_DESKTOP_SCALE, MIN_SCALE, MAX_SCALE);

    return { help: args.help === true, version: args.version === true, config: config };
}

/** The version surface: bridge version plus the MCP tool schema version. */
function versionText() {
    return SERVER_NAME + ' ' + BRIDGE_VERSION + ' (tool schema ' + TOOL_SCHEMA_VERSION + ')';
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
        '  --desktopimagetype [jpeg|png|tiff|webp]  Desktop capture image type, default ' + DEFAULT_IMAGE_TYPE + ' (env MESHCENTRAL_DESKTOP_IMAGETYPE)',
        '  --desktopquality [0-100]    Desktop capture compression level, default 50 (env MESHCENTRAL_DESKTOP_QUALITY)',
        '  --desktopscale [pixels]     Desktop capture maximum frame width, default 1024 (env MESHCENTRAL_DESKTOP_SCALE)',
        '  --help                      Show this help',
        '  --version                   Show the bridge and tool schema versions',
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
    if (options.version) { stderr.write(versionText() + '\n'); return 0; }

    let client = null;
    try {
        client = new MeshCentralClient(options.config);
        await client.connect();
    } catch (error) {
        if (client != null) { try { await client.close(); } catch (ex) { } }
        stderr.write(SERVER_NAME + ': ' + redact(errorMessage(error)) + '\n');
        return 1;
    }

    const server = createBridgeServer({
        client: client,
        defaults: {
            imageType: options.config.defaultImageType,
            quality: options.config.defaultQuality,
            scale: options.config.defaultScale
        }
    });
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
    createMcpServer: createBridgeServer,
    createBridgeServer: createBridgeServer,
    versionText: versionText,
    usageText: usageText,
    redact: redact,
    main: main
};
