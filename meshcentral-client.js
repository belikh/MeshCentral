'use strict';

/**
* @description Reusable client for the MeshCentral control protocol.
*
* Owns the websocket connection to the control endpoint, authentication
* (user/password header, login key cookie, login key file signing), command
* dispatch with per-call response correlation and timeouts, best-effort
* startup discovery of the server version and the account's rights, and a
* clean close.
*
* Requiring this module has no side effects: it parses no arguments, prints
* nothing and never exits. Open a connection with connect() and release it
* with close().
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://localhost/control.ashx';
const DEFAULT_COMMAND_TIMEOUT = 30000;
const DEFAULT_CONNECT_TIMEOUT = 30000;
const CLOSE_GRACE_TIMEOUT = 2000;

/** Base class for every error thrown or rejected by this module. */
class MeshCentralError extends Error {
    constructor(message, code) {
        super(message);
        this.name = this.constructor.name;
        this.code = (code != null) ? code : null;
    }
}

/** Invalid client configuration, thrown by the constructor. */
class ConfigurationError extends MeshCentralError { }

/** A server that cannot be reached, or a connection that dropped. */
class ConnectionError extends MeshCentralError { }

/** The server refused the supplied credentials. */
class AuthError extends MeshCentralError {
    constructor(message, code, serverMessage) {
        super(message, code);
        this.serverMessage = (serverMessage != null) ? serverMessage : null;
    }
}

/** A command (or the connection handshake) exceeded its timeout. */
class TimeoutError extends MeshCentralError {
    constructor(message, code, action, timeout) {
        super(message, code);
        this.action = (action != null) ? action : null;
        this.timeout = (timeout != null) ? timeout : null;
    }
}

/** A desktop relay session could not be launched. */
class RelayError extends MeshCentralError {
    constructor(message, code, result) {
        super(message, code);
        this.result = (result != null) ? result : null;
    }
}

function onVerifyServer(clientName, certs) { return null; }

// Turn a server close message into an actionable error message. The wording
// matches meshctrl so existing operators see the messages they know.
function authErrorMessage(data, usingLoginKey) {
    if (data.cause === 'locked') { return 'Account locked. Please contact the administrator.'; }
    if (data.cause === 'banned') { return 'Access temporarily blocked due to too many failed login attempts.'; }
    if (data.cause === 'noauth') {
        if (data.msg === 'tokenrequired') { return 'Authentication token required, use --token [number].'; }
        if (data.msg === 'nokey') { return 'URL key is invalid or missing, please specify ?key=xxx in url'; }
        if (usingLoginKey) { return 'Invalid login, check the login key and that this computer has the correct time.'; }
        return 'Invalid login.';
    }
    return (data.msg != null) ? ('Connection closed: ' + data.msg) : ('Connection closed: ' + data.cause);
}

function connectionErrorMessage(err, controlUrl) {
    if ((err != null) && (err.code === 'ENOTFOUND')) { return 'Unable to resolve ' + controlUrl; }
    return 'Unable to connect to ' + controlUrl;
}

// Complete a bare device id into a full 'node/<domain>/<id>' mesh nodeid. The
// control protocol completes bare ids with the connection's domain, and the
// desktop multiplexor requires the full nodeid in the viewer url.
function completeNodeId(nodeid, domain) {
    if ((typeof nodeid !== 'string') || (nodeid.length === 0)) { throw new ConfigurationError('A node id is required to launch a desktop session.', 'EINVALIDNODEID'); }
    if (nodeid.indexOf('/') === -1) { return 'node/' + ((domain != null) ? '' + domain : '') + '/' + nodeid; }
    return nodeid;
}

// Build the viewer websocket url from the sanitised control url, mirroring
// the browser viewer: the same host and domain path, meshrelay.ashx instead of
// control.ashx, browser=1 so the desktop multiplexor classifies this peer as a
// viewer, p=2 for the desktop protocol, the tunnel id and nodeid, and the
// login cookie as the auth query parameter.
function desktopRelayUrl(controlUrl, params) {
    params = params || {};
    let url = null;
    try { url = new URL('' + controlUrl); } catch (ex) { throw new ConfigurationError('Invalid control url: ' + controlUrl, 'EINVALIDURL'); }
    const directory = url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);
    url.pathname = directory + 'meshrelay.ashx';
    url.search = '';
    url.searchParams.set('browser', '1');
    url.searchParams.set('p', '' + ((params.protocol != null) ? params.protocol : 2));
    url.searchParams.set('nodeid', '' + params.nodeid);
    url.searchParams.set('id', '' + params.id);
    if (params.cookie != null) { url.searchParams.set('auth', '' + params.cookie); }
    return url.toString();
}

// Build the agent installer download url from the sanitised control url,
// mirroring meshctrl: the websocket scheme swapped for https, control.ashx for
// meshagents, and the agent type, device group and optional installer flags.
function agentDownloadUrl(controlUrl, params) {
    params = params || {};
    let url = String(controlUrl).replace('wss://', 'https://').replace('/control.ashx', '/meshagents');
    url += (url.indexOf('?') > 0) ? '&' : '?';
    url += 'id=' + params.type + '&meshid=' + params.meshid;
    if (params.installflags != null) { url += '&installflags=' + params.installflags; }
    return url;
}

// Encode an object as a cookie using a key using AES-GCM. (key must be 32 bytes or more)
function encodeCookie(o, key) {
    try {
        if (key == null) { return null; }
        o.time = Math.floor(Date.now() / 1000); // Add the cookie creation time
        const iv = Buffer.from(crypto.randomBytes(12), 'binary'), cipher = crypto.createCipheriv('aes-256-gcm', key.slice(0, 32), iv);
        const crypted = Buffer.concat([cipher.update(JSON.stringify(o), 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), crypted]).toString('base64').replace(/\+/g, '@').replace(/\//g, '$');
    } catch (e) { return null; }
}

// Normalise the control url and resolve every authentication material into a
// ready-to-connect url and headers, without touching the network.
function resolveAuth(config) {
    let url = (config.url != null) ? config.url : DEFAULT_URL;
    if (config.url != null) {
        if ((typeof url !== 'string') || (url.length < 5) || ((url.startsWith('wss://') === false) && (url.startsWith('ws://') === false))) {
            throw new ConfigurationError('Invalid url.', 'EINVALIDURL');
        }
        var i = url.indexOf('?key='), loginKey = null;
        if (i >= 0) { loginKey = url.substring(i + 5); url = url.substring(0, i); }
        if (url.endsWith('/') == false) { url += '/'; }
        url += 'control.ashx';
        if (loginKey != null) { url += '?key=' + loginKey; }
    }
    const controlUrl = url;

    let rawKey = null;
    if (config.loginKey != null) {
        // User key passed in as argument hex or opaque cookie
        rawKey = '' + config.loginKey;
    } else if (config.loginKeyFile != null) {
        // Load key from hex file
        let contents = null;
        try {
            contents = require('fs').readFileSync(config.loginKeyFile, 'utf8');
        } catch (ex) {
            throw new ConfigurationError(ex.message, 'EKEYFILE');
        }
        rawKey = contents.split(' ').join('').split('\r').join('').split('\n').join('');
    }

    let usingLoginKey = false;
    if (rawKey != null) {
        usingLoginKey = true;
        const key = Buffer.from(rawKey, 'hex');
        if ((rawKey.length === 160) && (key.length === 80)) {
            // A full 160 hex digit key is used to sign a login cookie.
            const domainid = (config.domain != null) ? '' + config.domain : '';
            const username = (config.user != null) ? '' + config.user : 'admin';
            url += (url.indexOf('?key=') >= 0 ? '&auth=' : '?auth=') + encodeCookie({ userid: 'user/' + domainid + '/' + username, domainid: domainid }, key);
        } else {
            // Anything else is passed through as a login cookie.
            if (config.domain != null) {
                throw new ConfigurationError('--logindomain can only be used along with --loginkey.', 'EINVALIDCONFIG');
            }
            url += (url.indexOf('?key=') >= 0 ? '&auth=' : '?auth=') + rawKey;
        }
    } else if (config.domain != null) {
        throw new ConfigurationError('--logindomain can only be used along with --loginkey.', 'EINVALIDCONFIG');
    }

    // Password authentication
    const headers = {};
    if (config.password != null) {
        const username = (config.user != null) ? '' + config.user : 'admin';
        let token = '';
        if (config.token != null) { token = ',' + Buffer.from('' + config.token).toString('base64'); }
        headers['x-meshauth'] = Buffer.from(username).toString('base64') + ',' + Buffer.from('' + config.password).toString('base64') + token;
    }

    return { controlUrl: controlUrl, url: url, usingLoginKey: usingLoginKey, headers: headers };
}

/**
* A reusable MeshCentral control-protocol client.
*
* Configuration:
*   url                Server url such as wss://server:443, optionally with
*                      ?key=... It may also end in /control.ashx.
*   user               Login username (default 'admin').
*   password           Login password. Enables x-meshauth authentication.
*   token              Optional second factor token, used with password.
*   loginKey           160 hex digit login key, or an opaque login cookie.
*   loginKeyFile       File holding a 160 hex digit login key.
*   domain             Domain id, used when signing with a login key.
*   proxy              HTTP proxy url.
*   rejectUnauthorized Verify the server certificate (default false).
*   checkServerIdentity Certificate identity check callback.
*   commandTimeout     Default per-command timeout in ms (default 30000, 0 disables).
*   connectTimeout     Handshake timeout in ms (default 30000, 0 disables).
*
* Events:
*   message (rawData)  Every message received, raw, after correlation.
*   close ({...})      The connection closed; carries code, reason, cause, msg.
*   error (error)      Transport errors, emitted only when a listener exists.
*/
class MeshCentralClient extends EventEmitter {
    constructor(config) {
        super();
        config = config || {};
        this.config = config;

        this.commandTimeout = (config.commandTimeout != null) ? config.commandTimeout : DEFAULT_COMMAND_TIMEOUT;
        this.connectTimeout = (config.connectTimeout != null) ? config.connectTimeout : DEFAULT_CONNECT_TIMEOUT;

        const auth = resolveAuth(config);
        this.controlUrl = auth.controlUrl; // Sanitised control endpoint, safe to log
        this.url = auth.url; // Effective websocket url, may contain credentials
        this._usingLoginKey = auth.usingLoginKey;

        const options = { rejectUnauthorized: config.rejectUnauthorized === true, checkServerIdentity: config.checkServerIdentity || onVerifyServer };
        if (Object.keys(auth.headers).length > 0) { options.headers = auth.headers; }
        if (config.proxy != null) {
            let HttpsProxyAgent = null;
            try { HttpsProxyAgent = require('https-proxy-agent'); }
            catch (ex) { throw new ConfigurationError('Missing module "https-proxy-agent", type "npm install https-proxy-agent" to install it.', 'EMISSINGMODULE'); }
            options.agent = new HttpsProxyAgent(new URL(config.proxy));
        }
        this._wsOptions = options;

        // Connection state
        this.ws = null;
        this.authenticated = false;
        this.transportOpen = false;

        // Startup discovery
        this.serverInfo = null;
        this.userInfo = null;
        this.rights = null;
        this.serverVersion = null;

        // Lifecycle bookkeeping
        this.closeInfo = null;
        this.lastError = null;
        this._pending = new Map();
        this._nextResponseId = 1;
        this._connectPromise = null;
        this._closing = false;
    }

    /**
    * Open the connection and complete the authentication handshake. Resolves
    * with this client once the server sent serverinfo and userinfo; rejects
    * with an AuthError, ConnectionError or TimeoutError otherwise. Server
    * version discovery is best effort and never fails the connection.
    */
    connect(options) {
        options = options || {};
        if (this.authenticated) { return Promise.resolve(this); }
        if (this._connectPromise != null) { return this._connectPromise; }

        const timeout = (options.timeout != null) ? options.timeout : this.connectTimeout;

        this.serverInfo = null;
        this.userInfo = null;
        this.rights = null;
        this.serverVersion = null;
        this.closeInfo = null;
        this._closing = false;

        this._connectPromise = new Promise((resolve, reject) => {
            let settled = false;
            let discoveryStarted = false;
            let handshakeTimer = null;

            const settle = (error) => {
                if (settled) { return; }
                settled = true;
                if (handshakeTimer != null) { clearTimeout(handshakeTimer); handshakeTimer = null; }
                if (error != null) { reject(error); } else { resolve(this); }
            };

            const discover = () => {
                // Best effort: a server that denies or ignores serverversion
                // leaves serverVersion null without failing the connection.
                this.request('serverversion', {}, { timeout: this.commandTimeout }).then((response) => {
                    if ((response != null) && (response.tags != null)) { this.serverVersion = response.tags; }
                    settle(null);
                }, () => { settle(null); });
            };

            const authenticated = () => {
                if (settled || discoveryStarted) { return; }
                if ((this.serverInfo == null) || (this.userInfo == null)) { return; }
                discoveryStarted = true;
                this.authenticated = true;
                if (handshakeTimer != null) { clearTimeout(handshakeTimer); handshakeTimer = null; }
                discover();
            };

            const onMessage = (raw) => {
                let data = null;
                try { data = JSON.parse(raw.toString()); } catch (ex) { }
                if (data != null) {
                    let correlated = false;
                    if (data.responseid != null) {
                        const pending = this._pending.get(data.responseid);
                        if (pending != null) {
                            this._pending.delete(data.responseid);
                            if (pending.timer != null) { clearTimeout(pending.timer); }
                            pending.resolve(data);
                            correlated = true;
                        }
                    }
                    if (!correlated && (data.action != null)) {
                        // Some server replies omit the responseid entirely (the
                        // deviceShares listing); those requests ask to match on
                        // the action instead.
                        for (const [responseid, pending] of this._pending) {
                            if (pending.matchAction === data.action) {
                                this._pending.delete(responseid);
                                if (pending.timer != null) { clearTimeout(pending.timer); }
                                pending.resolve(data);
                                break;
                            }
                        }
                    }
                    if ((data.action === 'serverinfo') && (data.serverinfo != null)) {
                        this.serverInfo = data.serverinfo;
                        authenticated();
                    } else if ((data.action === 'userinfo') && (data.userinfo != null)) {
                        this.userInfo = data.userinfo;
                        this.rights = (typeof data.userinfo.siteadmin === 'number') ? data.userinfo.siteadmin : null;
                        authenticated();
                    } else if (data.action === 'close') {
                        this.closeInfo = { cause: data.cause, msg: data.msg };
                        if (!settled) {
                            settle(new AuthError(authErrorMessage(data, this._usingLoginKey), data.cause, data.msg));
                        }
                    }
                }
                this.emit('message', raw);
            };

            const onClose = (code, reason) => {
                this.transportOpen = false;
                this.authenticated = false;
                this.ws = null;
                this._connectPromise = null;
                const closeInfo = this.closeInfo;
                const pendingError = ((closeInfo != null) && (closeInfo.cause === 'noauth'))
                    ? new AuthError(authErrorMessage(closeInfo, this._usingLoginKey), closeInfo.cause, closeInfo.msg)
                    : new ConnectionError(this._closing ? 'Connection closed.' : 'Connection closed while waiting for a response.', 'ECLOSED');
                for (const entry of this._pending.values()) {
                    if (entry.timer != null) { clearTimeout(entry.timer); }
                    entry.reject(pendingError);
                }
                this._pending.clear();
                if (!settled) {
                    settle((closeInfo != null)
                        ? new AuthError(authErrorMessage(closeInfo, this._usingLoginKey), closeInfo.cause, closeInfo.msg)
                        : new ConnectionError('Connection closed before authentication completed.', 'ECLOSED'));
                }
                this.emit('close', {
                    code: code,
                    reason: (reason != null) ? reason.toString() : null,
                    cause: (closeInfo != null) ? closeInfo.cause : null,
                    msg: (closeInfo != null) ? closeInfo.msg : null
                });
            };

            const ws = new WebSocket(this.url, this._wsOptions);
            this.ws = ws;

            if (timeout > 0) {
                handshakeTimer = setTimeout(() => {
                    const error = new TimeoutError('Connection to ' + this.controlUrl + ' timed out after ' + timeout + 'ms.', 'ETIMEDOUT', 'connect', timeout);
                    settle(error);
                    this._emitError(error);
                    try { ws.terminate(); } catch (ex) { }
                }, timeout);
            }

            ws.on('open', () => {
                this.transportOpen = true;
            });

            ws.on('message', onMessage);

            ws.on('error', (err) => {
                this.lastError = err;
                const error = new ConnectionError(connectionErrorMessage(err, this.controlUrl), err.code);
                if (!settled) { settle(error); }
                this._emitError(error);
            });

            ws.on('close', onClose);
        });

        return this._connectPromise;
    }

    /**
    * Send one command and resolve when the response carrying its own
    * responseid arrives. Options: responseid (override the generated id),
    * matchAction (also resolve on a message whose action matches, for server
    * replies that omit the responseid), timeout (ms, 0 disables). Rejects with
    * TimeoutError, ConnectionError or AuthError.
    */
    request(action, params, options) {
        params = params || {};
        options = options || {};
        if ((this.ws == null) || !this.transportOpen) {
            return Promise.reject(new ConnectionError('Not connected to ' + this.controlUrl + '.', 'ENOTCONNECTED'));
        }
        const responseid = (options.responseid != null) ? options.responseid : this.newResponseId();
        const timeout = (options.timeout != null) ? options.timeout : this.commandTimeout;
        return new Promise((resolve, reject) => {
            const entry = { resolve: resolve, reject: reject, action: action, timer: null, matchAction: (options.matchAction === true) ? action : null };
            if (timeout > 0) {
                entry.timer = setTimeout(() => {
                    if (this._pending.get(responseid) === entry) {
                        this._pending.delete(responseid);
                        reject(new TimeoutError('Command "' + action + '" timed out after ' + timeout + 'ms.', 'ETIMEDOUT', action, timeout));
                    }
                }, timeout);
            }
            this._pending.set(responseid, entry);
            try {
                this.send(Object.assign({}, params, { action: action, responseid: responseid }));
            } catch (ex) {
                this._pending.delete(responseid);
                if (entry.timer != null) { clearTimeout(entry.timer); }
                reject(ex);
            }
        });
    }

    /**
    * Send one command and resolve with the first response carrying the same
    * action. Some server responses do not echo the request's responseid
    * (login token listings, reports), so they cannot be correlated by
    * responseid; this matches them on action instead. Options: timeout (ms,
    * 0 disables). Rejects with TimeoutError, ConnectionError or AuthError.
    */
    requestByAction(action, params, options) {
        params = params || {};
        options = options || {};
        if ((this.ws == null) || !this.transportOpen) {
            return Promise.reject(new ConnectionError('Not connected to ' + this.controlUrl + '.', 'ENOTCONNECTED'));
        }
        const timeout = (options.timeout != null) ? options.timeout : this.commandTimeout;
        return new Promise((resolve, reject) => {
            let timer = null, finished = false;
            const cleanup = () => {
                this.removeListener('message', onMessage);
                this.removeListener('close', onClose);
                if (timer != null) { clearTimeout(timer); }
            };
            const settle = (error, value) => {
                if (finished) { return; }
                finished = true;
                cleanup();
                if (error != null) { reject(error); } else { resolve(value); }
            };
            const onMessage = (raw) => {
                let data = null;
                try { data = JSON.parse(raw.toString()); } catch (ex) { return; }
                if ((data != null) && (data.action === action)) { settle(null, data); }
            };
            const onClose = () => { settle(new ConnectionError('Connection closed while waiting for a response.', 'ECLOSED')); };
            if (timeout > 0) {
                timer = setTimeout(() => {
                    settle(new TimeoutError('Command "' + action + '" timed out after ' + timeout + 'ms.', 'ETIMEDOUT', action, timeout));
                }, timeout);
                if (timer.unref) { timer.unref(); }
            }
            this.on('message', onMessage);
            this.once('close', onClose);
            try {
                this.send(Object.assign({}, params, { action: action, responseid: this.newResponseId() }));
            } catch (ex) {
                settle(ex);
            }
        });
    }

    /** Send a raw string or object on the control connection. */
    send(message) {
        if ((this.ws == null) || (this.ws.readyState !== WebSocket.OPEN)) {
            throw new ConnectionError('Not connected to ' + this.controlUrl + '.', 'ENOTCONNECTED');
        }
        this.ws.send((typeof message === 'string') ? message : JSON.stringify(message));
    }

    /** Generate a response id unique to this client and call. */
    newResponseId() {
        return 'mc-' + process.pid.toString(36) + '-' + (this._nextResponseId++).toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    }

    /**
    * Download an agent installer for a device group from the server's
    * meshagents endpoint and save it next to the bridge, mirroring meshctrl:
    * the same url (https, /meshagents, id, meshid, optional installflags), the
    * server supplied filename and a refusal to overwrite an existing file.
    *
    * Options:
    *   type         Agent architecture number (required).
    *   meshid       Device group id (required).
    *   installflags Optional installer flags.
    *   directory    Directory to save into (default: the process working directory).
    *   timeout      Download timeout in ms (default: commandTimeout, 0 disables).
    *   request      Optional https.request-compatible function, for tests.
    *
    * Resolves with { filename, path, size }. Rejects with TimeoutError, or a
    * MeshCentralError carrying the server status or the existing-file message.
    */
    downloadAgent(options) {
        options = options || {};
        const url = agentDownloadUrl(this.controlUrl, options);
        const directory = (options.directory != null) ? options.directory : process.cwd();
        const timeout = (options.timeout != null) ? options.timeout : this.commandTimeout;
        const requestFn = (typeof options.request === 'function') ? options.request : https.request;
        return new Promise((resolve, reject) => {
            let finished = false;
            const fail = (error) => {
                if (finished) { return; }
                finished = true;
                reject(error);
            };
            const req = requestFn(url, { rejectUnauthorized: false, checkServerIdentity: onVerifyServer }, (res) => {
                if (res.statusCode !== 200) {
                    fail(new MeshCentralError('Download error, statusCode: ' + res.statusCode, 'EDOWNLOAD'));
                    try { if (typeof res.resume === 'function') { res.resume(); } } catch (ex) { }
                    return;
                }
                let filename = 'meshagent';
                const disposition = (res.headers != null) ? res.headers['content-disposition'] : null;
                if (typeof disposition === 'string') {
                    const i = disposition.indexOf('filename="');
                    if (i >= 0) {
                        filename = disposition.substring(i + 10);
                        const j = filename.indexOf('"');
                        if (j >= 0) { filename = filename.substring(0, j); }
                    }
                }
                filename = path.basename(filename);
                const chunks = [];
                res.on('data', (chunk) => { chunks.push(chunk); });
                res.on('error', fail);
                res.on('end', () => {
                    if (finished) { return; }
                    const data = Buffer.concat(chunks);
                    const filePath = path.join(directory, filename);
                    try {
                        if (fs.existsSync(filePath)) { throw new MeshCentralError('File "' + filename + '" already exists.', 'EEXISTS'); }
                        fs.writeFileSync(filePath, data);
                    } catch (ex) { fail(ex); return; }
                    finished = true;
                    resolve({ filename: filename, path: filePath, size: data.length });
                });
            });
            req.on('error', fail);
            if ((timeout > 0) && (typeof req.setTimeout === 'function')) {
                req.setTimeout(timeout, () => {
                    fail(new TimeoutError('Command "agentdownload" timed out after ' + timeout + 'ms.', 'ETIMEDOUT', 'agentdownload', timeout));
                    try { req.destroy(); } catch (ex) { }
                });
            }
            req.end();
        });
    }

    /**
    * Ask the server for a relay authentication cookie pair. Resolves with
    * { cookie, rcookie }: cookie authenticates the viewer websocket through
    * the ?auth= query parameter (one hour validity), rcookie authorises the
    * agent side of the relay through the tunnel message's ?rauth= parameter
    * (four hour validity). The browser and meshctrl request this pair before
    * every relay session. The reply carries no responseid, so it is matched
    * on action and an optional timeout.
    */
    authCookie(options) {
        options = options || {};
        const timeout = (options.timeout != null) ? options.timeout : this.commandTimeout;
        if ((this.ws == null) || !this.transportOpen) {
            return Promise.reject(new ConnectionError('Not connected to ' + this.controlUrl + '.', 'ENOTCONNECTED'));
        }
        return new Promise((resolve, reject) => {
            let timer = null, finished = false;
            const cleanup = () => {
                this.removeListener('message', onMessage);
                this.removeListener('close', onClose);
                if (timer != null) { clearTimeout(timer); }
            };
            const settle = (error, value) => {
                if (finished) { return; }
                finished = true;
                cleanup();
                if (error != null) { reject(error); } else { resolve(value); }
            };
            const onMessage = (raw) => {
                let data = null;
                try { data = JSON.parse(raw.toString()); } catch (ex) { }
                if ((data == null) || (data.action !== 'authcookie')) { return; }
                settle(null, { cookie: data.cookie, rcookie: data.rcookie });
            };
            const onClose = () => { settle(new ConnectionError('Connection closed while waiting for authcookie.', 'ECLOSED')); };
            if (timeout > 0) {
                timer = setTimeout(() => { settle(new TimeoutError('Command "authcookie" timed out after ' + timeout + 'ms.', 'ETIMEDOUT', 'authcookie', timeout)); }, timeout);
                if (timer.unref) { timer.unref(); }
            }
            this.on('message', onMessage);
            this.once('close', onClose);
            try {
                this.send({ action: 'authcookie' });
            } catch (ex) {
                settle(ex);
            }
        });
    }

    /**
    * Launch a desktop relay session for a node and return everything a
    * DesktopCapture viewer needs to connect. This mirrors the browser viewer:
    * obtain relay cookies, ask the server to route a tunnel message to the
    * agent ({action:'msg', type:'tunnel', usage:2}, value being a server
    * rooted relay url carrying p=2, nodeid, id and rauth), then connect the
    * viewer websocket to meshrelay.ashx with browser=1, p=2, the same nodeid
    * and id and the login cookie as ?auth=.
    *
    * Options:
    *   id         Explicit tunnel id (default: 12 random hex characters).
    *   auth       Pre-fetched { cookie, rcookie } from authCookie().
    *   domain     Domain id used to complete a bare device id.
    *   timeout    Timeout in ms for the auth cookie and tunnel commands.
    *   imageType, compression, scaling, frameRate, options
    *              Passed through to session.captureConfig for DesktopCapture.
    *
    * Resolves with a DesktopRelaySession. Rejects with RelayError when the
    * server refuses to route the tunnel, and with TimeoutError,
    * ConnectionError or AuthError from the underlying control commands.
    */
    launchDesktopSession(nodeid, options) {
        options = options || {};
        if ((this.ws == null) || !this.transportOpen) {
            return Promise.reject(new ConnectionError('Not connected to ' + this.controlUrl + '.', 'ENOTCONNECTED'));
        }
        let fullNodeId = null;
        try {
            fullNodeId = completeNodeId(nodeid, (options.domain != null) ? options.domain : ((this.serverInfo != null) ? this.serverInfo.domain : null));
        } catch (ex) {
            return Promise.reject(ex);
        }
        const tunnelId = (options.id != null) ? '' + options.id : crypto.randomBytes(6).toString('hex');
        const timeout = (options.timeout != null) ? options.timeout : this.commandTimeout;
        const authPromise = (options.auth != null) ? Promise.resolve(options.auth) : this.authCookie({ timeout: timeout });
        return authPromise.then((auth) => {
            if ((auth == null) || (typeof auth.cookie !== 'string') || (typeof auth.rcookie !== 'string')) {
                throw new RelayError('The server did not return usable relay authentication cookies.', 'ENOAUTH');
            }
            const value = '*/meshrelay.ashx?p=2&nodeid=' + fullNodeId + '&id=' + tunnelId + '&rauth=' + auth.rcookie;
            return this.request('msg', { nodeid: fullNodeId, type: 'tunnel', usage: 2, value: value }, { timeout: timeout }).then((response) => {
                if ((response == null) || (response.result !== 'OK')) {
                    const result = (response != null) ? response.result : null;
                    throw new RelayError('Unable to launch a desktop relay session for ' + fullNodeId +
                        ((result != null) ? ': ' + result : '. The server closed the connection.'), 'ELAUCHFAILED', result);
                }
                const captureConfig = { url: desktopRelayUrl(this.controlUrl, { nodeid: fullNodeId, id: tunnelId, cookie: auth.cookie }) };
                for (const key of ['imageType', 'compression', 'scaling', 'frameRate', 'options']) {
                    if (options[key] !== undefined) { captureConfig[key] = options[key]; }
                }
                return new DesktopRelaySession({
                    client: this,
                    nodeid: fullNodeId,
                    tunnelId: tunnelId,
                    url: captureConfig.url,
                    cookie: auth.cookie,
                    rcookie: auth.rcookie,
                    usage: 2,
                    response: response,
                    captureConfig: captureConfig
                });
            });
        });
    }

    /** Close the connection cleanly, falling back to a terminate after a grace period. */
    close() {
        this._closing = true;
        if (this.ws == null) {
            this.authenticated = false;
            return Promise.resolve();
        }
        const ws = this.ws;
        return new Promise((resolve) => {
            let finished = false;
            let timer = null;
            const finish = () => {
                if (finished) { return; }
                finished = true;
                if (timer != null) { clearTimeout(timer); }
                resolve();
            };
            timer = setTimeout(() => { try { ws.terminate(); } catch (ex) { } finish(); }, CLOSE_GRACE_TIMEOUT);
            ws.once('close', finish);
            try {
                if (ws.readyState === WebSocket.CONNECTING) { ws.terminate(); } else { ws.close(); }
            } catch (ex) { finish(); }
        });
    }

    _emitError(error) {
        if (this.listenerCount('error') > 0) { this.emit('error', error); }
    }
}

/**
* A launched desktop relay session. Carries the viewer url, the relay cookies
* and the control response so a DesktopCapture viewer can connect, and a
* release() that closes the viewer. Closing the viewer websocket is what ends
* the server-side relay session (there is no control-channel release message),
* so attach() the DesktopCapture instance and release() will close it.
*/
class DesktopRelaySession {
    constructor(details) {
        details = details || {};
        this.client = details.client || null;
        this.nodeid = details.nodeid || null;
        this.tunnelId = details.tunnelId || null;
        this.url = details.url || null;
        this.cookie = details.cookie || null;
        this.rcookie = details.rcookie || null;
        this.usage = details.usage || 2;
        this.response = details.response || null;
        this.captureConfig = details.captureConfig || { url: this.url };
        this.released = false;
        this.capture = null;
        this._releasePromise = null;
    }

    /** Associate the viewer (a DesktopCapture or anything with close()). */
    attach(capture) {
        if (this.released) { throw new RelayError('This desktop relay session has been released.', 'ERELEASED'); }
        this.capture = capture;
        return capture;
    }

    /**
    * Release the session by closing the attached viewer. Idempotent; safe to
    * call without an attached viewer. Resolves once the viewer has closed.
    */
    release() {
        if (this._releasePromise != null) { return this._releasePromise; }
        this.released = true;
        const capture = this.capture;
        this._releasePromise = ((capture != null) && (typeof capture.close === 'function'))
            ? Promise.resolve(capture.close())
            : Promise.resolve();
        return this._releasePromise;
    }
}

module.exports = {
    MeshCentralClient: MeshCentralClient,
    DesktopRelaySession: DesktopRelaySession,
    MeshCentralError: MeshCentralError,
    ConfigurationError: ConfigurationError,
    ConnectionError: ConnectionError,
    AuthError: AuthError,
    TimeoutError: TimeoutError,
    RelayError: RelayError,
    desktopRelayUrl: desktopRelayUrl,
    agentDownloadUrl: agentDownloadUrl
};
