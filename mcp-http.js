'use strict';

/**
* @description MCP Streamable HTTP endpoint for the MeshCentral daemon.
*
* Mounted on the existing HTTPS listener at /mcp. Every request is
* authenticated first (the caller supplies an authenticate function); each
* authenticated MCP session owns one MeshCentral control connection built by
* the shared bridge factory, and idle sessions are closed. The transport
* wiring comes from the MCP SDK; this module owns the session lifecycle only.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { randomUUID } = require('crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { createBridgeServer, createAuditLog } = require('./mcp-bridge.js');

const DEFAULT_IDLE_TIMEOUT = 10 * 60 * 1000;

/** Read a JSON request body; resolved bodies from an upstream parser win. */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        if (req.body != null) { resolve(req.body); return; }
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => {
            if (data.length === 0) { resolve(undefined); return; }
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function sendJsonRpcError(res, status, code, message) {
    if (res.headersSent) { return; }
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: code, message: message }, id: null });
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

/**
* Build the /mcp request handler.
*
* Options:
*   authenticate(req)   Required. Promise<account|null>; null means 401.
*   createClient(account) Required. Promise<client> for one MCP session; the
*                       client is connected by this module.
*   audit               Audit sink; defaults to stderr. Records gain an
*                       `account` field.
*   idleTimeout         Idle milliseconds before a session is closed.
*   setTimeout/clearTimeout  Timer seams for tests.
*
* Returns (req, res) => Promise<void>, usable directly as an http request
* listener or as an Express route handler.
*/
function createMcpHttpHandler(options) {
    options = options || {};
    if (typeof options.authenticate !== 'function') { throw new Error('createMcpHttpHandler requires an authenticate function.'); }
    if (typeof options.createClient !== 'function') { throw new Error('createMcpHttpHandler requires a createClient function.'); }

    const audit = options.audit || createAuditLog();
    const idleTimeout = (options.idleTimeout != null) ? options.idleTimeout : DEFAULT_IDLE_TIMEOUT;
    const schedule = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    const sessions = new Map();

    function dispose(session) {
        if ((session == null) || (session.disposed === true)) { return undefined; }
        session.disposed = true;
        if (session.timer != null) { cancel(session.timer); session.timer = null; }
        if (session.id != null) { sessions.delete(session.id); }
        const closing = [];
        if ((session.transport != null) && (typeof session.transport.close === 'function')) { closing.push(Promise.resolve().then(() => session.transport.close())); }
        if ((session.bridge != null) && (typeof session.bridge.close === 'function')) { closing.push(Promise.resolve().then(() => session.bridge.close())); }
        if ((session.client != null) && (typeof session.client.close === 'function')) { closing.push(Promise.resolve().then(() => session.client.close())); }
        return Promise.allSettled(closing);
    }

    function touch(session) {
        session.lastUsed = Date.now();
        if (session.timer != null) { cancel(session.timer); }
        session.timer = schedule(() => { dispose(session); }, idleTimeout);
    }

    async function startSession(account, body, req, res) {
        const session = { id: null, transport: null, bridge: null, client: null, account: account, timer: null, disposed: false };
        const client = await options.createClient(account);
        session.client = client;
        try {
            await client.connect();
            session.bridge = createBridgeServer({
                client: client,
                audit: {
                    record: (entry) => audit.record(Object.assign({ account: (account != null) ? account.userid : null }, entry))
                }
            });
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    session.id = id;
                    sessions.set(id, session);
                    touch(session);
                },
                onsessionclosed: () => { dispose(session); }
            });
            session.transport = transport;
            await session.bridge.mcp.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch (error) {
            await dispose(session);
            throw error;
        }
    }

    return async function mcpHttpHandler(req, res) {
        let account = null;
        try {
            account = await options.authenticate(req);
        } catch (error) {
            account = null;
        }
        if (account == null) {
            sendJsonRpcError(res, 401, -32001, 'Unauthorized');
            return;
        }

        const sessionId = req.headers['mcp-session-id'];
        if (sessionId != null) {
            const session = sessions.get(sessionId);
            if (session == null) {
                sendJsonRpcError(res, 404, -32001, 'Session not found');
                return;
            }
            touch(session);
            try {
                await session.transport.handleRequest(req, res, await readJsonBody(req));
            } catch (error) {
                await dispose(session);
                sendJsonRpcError(res, 500, -32603, 'Internal error');
            }
            return;
        }

        if (req.method !== 'POST') {
            sendJsonRpcError(res, 400, -32000, 'Bad Request: an initialization request is required.');
            return;
        }

        try {
            await startSession(account, await readJsonBody(req), req, res);
        } catch (error) {
            sendJsonRpcError(res, 500, -32603, 'Failed to start the MCP session.');
        }
    };
}

module.exports = {
    DEFAULT_IDLE_TIMEOUT: DEFAULT_IDLE_TIMEOUT,
    readJsonBody: readJsonBody,
    createMcpHttpHandler: createMcpHttpHandler
};
