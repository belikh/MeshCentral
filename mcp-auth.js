'use strict';

/**
* @description Bearer login-token authentication for the MCP HTTP endpoint.
*
* Parses `Authorization: Bearer mt_...` and resolves the credential to the
* owning MeshCentral account using the same checks as the password login path:
* the login-token record must exist, be unexpired, its password must hash to
* the stored hash, and the owning account must exist and not be locked. No
* Express coupling, so it can be tested directly.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { decodeCredential } = require('./mcp-credential.js');

const BEARER = /^\s*Bearer\s+(\S+)\s*$/i;

/** Parse the Authorization header into a token pair, or null when it is not one. */
function parseBearerCredential(header) {
    if (typeof header !== 'string') { return null; }
    const match = BEARER.exec(header);
    if (match == null) { return null; }
    try {
        return decodeCredential(match[1]);
    } catch (error) {
        return null;
    }
}

/**
* Build the request authenticator.
*
* Services:
*   getLoginToken(tokenUser)                  -> Promise<login token record|null>
*   hashPassword(password, salt)              -> Promise<stored hash string>
*   getUser(userid)                           -> Promise<user record|null>
*
* Returns Promise<account|null>; account carries userid, username and the
* credential pair so a control connection can be opened with it.
*/
function createLoginTokenAuthenticator(services) {
    services = services || {};
    if (typeof services.getLoginToken !== 'function') { throw new Error('createLoginTokenAuthenticator requires getLoginToken.'); }
    if (typeof services.hashPassword !== 'function') { throw new Error('createLoginTokenAuthenticator requires hashPassword.'); }
    if (typeof services.getUser !== 'function') { throw new Error('createLoginTokenAuthenticator requires getUser.'); }

    return async function authenticate(req) {
        const headers = (req != null) ? req.headers : null;
        const credential = parseBearerCredential((headers != null) ? headers.authorization : null);
        if (credential == null) { return null; }

        let loginToken = null;
        try {
            loginToken = await services.getLoginToken(credential.tokenUser);
        } catch (error) {
            return null;
        }
        if (loginToken == null) { return null; }
        if ((loginToken.expire != 0) && (loginToken.expire < Date.now())) { return null; }

        let hash = null;
        try {
            hash = await services.hashPassword(credential.tokenPass, loginToken.salt);
        } catch (error) {
            return null;
        }
        if (hash !== loginToken.hash) { return null; }

        let user = null;
        try {
            user = await services.getUser(loginToken.userid);
        } catch (error) {
            return null;
        }
        if (user == null) { return null; }
        if ((user.siteadmin) && (user.siteadmin != 0xFFFFFFFF) && ((user.siteadmin & 32) !== 0)) { return null; }

        return {
            userid: user._id,
            username: user.name,
            tokenUser: credential.tokenUser,
            tokenPass: credential.tokenPass,
            tokenName: loginToken.name
        };
    };
}

module.exports = {
    parseBearerCredential: parseBearerCredential,
    createLoginTokenAuthenticator: createLoginTokenAuthenticator
};
