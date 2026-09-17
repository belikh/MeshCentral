'use strict';

/**
* @description Bearer login-token authentication for the MCP HTTP endpoint.
*
* Parses `Authorization: Bearer mt_...` and resolves the credential to the
* owning MeshCentral account through the shared login-token verifier, which
* applies the same checks as the password login path: the login-token record
* must exist, be unexpired, its password must hash to the stored hash, and the
* owning account must exist and not be locked. No Express coupling, so it can
* be tested directly.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { decodeCredential } = require('./mcp-credential.js');
const { validateServices, verifyLoginToken } = require('./login-token.js');

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
    validateServices(services);

    return async function authenticate(req) {
        const headers = (req != null) ? req.headers : null;
        const credential = parseBearerCredential((headers != null) ? headers.authorization : null);
        if (credential == null) { return null; }

        let verified = null;
        try {
            verified = await verifyLoginToken(services, credential);
        } catch (error) {
            return null;
        }
        if (verified == null) { return null; }

        return {
            userid: verified.user._id,
            username: verified.user.name,
            tokenUser: credential.tokenUser,
            tokenPass: credential.tokenPass,
            tokenName: verified.loginToken.name
        };
    };
}

module.exports = {
    parseBearerCredential: parseBearerCredential,
    createLoginTokenAuthenticator: createLoginTokenAuthenticator
};
