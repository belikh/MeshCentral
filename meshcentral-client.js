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
                    if (data.responseid != null) {
                        const pending = this._pending.get(data.responseid);
                        if (pending != null) {
                            this._pending.delete(data.responseid);
                            if (pending.timer != null) { clearTimeout(pending.timer); }
                            pending.resolve(data);
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
    * timeout (ms, 0 disables). Rejects with TimeoutError, ConnectionError or
    * AuthError.
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
            const entry = { resolve: resolve, reject: reject, action: action, timer: null };
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

module.exports = {
    MeshCentralClient: MeshCentralClient,
    MeshCentralError: MeshCentralError,
    ConfigurationError: ConfigurationError,
    ConnectionError: ConnectionError,
    AuthError: AuthError,
    TimeoutError: TimeoutError
};
