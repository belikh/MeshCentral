'use strict';

/**
* @description Login-token connection credentials for MCP clients.
*
* MeshCentral login tokens are a username (`~t:` plus base64) and a password
* (base64) shown once at creation; only a salted hash of the password is
* stored. A single-string credential lets a client put the pair in one
* Authorization header:
*
*   mt_<base64url(tokenUser + ':' + tokenPass)>
*
* The colon inside `tokenUser` means the pair is split on the last colon; the
* password is base64 and therefore never contains a colon.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const PREFIX = 'mt_';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

class CredentialError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'CredentialError';
        this.code = code;
    }
}

/** Encode a login-token username/password pair into one connection credential. */
function encodeCredential(tokenUser, tokenPass) {
    if ((typeof tokenUser !== 'string') || (tokenUser.length === 0)) {
        throw new CredentialError('The token username is required.', 'E_FORMAT');
    }
    if ((typeof tokenPass !== 'string') || (tokenPass.length === 0)) {
        throw new CredentialError('The token password is required.', 'E_FORMAT');
    }
    return PREFIX + Buffer.from(tokenUser + ':' + tokenPass, 'utf8').toString('base64url');
}

/**
* Decode a connection credential. Throws CredentialError with a code:
* E_FORMAT (not a string, missing separator, empty parts),
* E_PREFIX (missing or wrong prefix) or E_ENCODING (not canonical base64url).
*/
function decodeCredential(credential) {
    if (typeof credential !== 'string') {
        throw new CredentialError('The credential must be a string.', 'E_FORMAT');
    }
    if (credential.startsWith(PREFIX) === false) {
        throw new CredentialError('The credential must start with "' + PREFIX + '".', 'E_PREFIX');
    }
    const body = credential.slice(PREFIX.length);
    if ((body.length === 0) || (BASE64URL.test(body) === false)) {
        throw new CredentialError('The credential body is not base64url.', 'E_ENCODING');
    }
    const decoded = Buffer.from(body, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== body) {
        throw new CredentialError('The credential body is not canonical base64url.', 'E_ENCODING');
    }
    const separator = decoded.lastIndexOf(':');
    if ((separator <= 0) || (separator === (decoded.length - 1))) {
        throw new CredentialError('The credential must contain a username and password separated by a colon.', 'E_FORMAT');
    }
    return { tokenUser: decoded.slice(0, separator), tokenPass: decoded.slice(separator + 1) };
}

module.exports = {
    PREFIX: PREFIX,
    CredentialError: CredentialError,
    encodeCredential: encodeCredential,
    decodeCredential: decodeCredential
};
