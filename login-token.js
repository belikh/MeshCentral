'use strict';

/**
* @description Shared verification of MeshCentral login-token credentials.
*
* A login token is a username (`~t:` plus base64) and a password; only a
* salted hash of the password is stored. Both the web login form and the
* `/mcp` endpoint resolve that pair through this module, so the checks cannot
* drift: the token record must exist, be unexpired, its password must hash to
* the stored hash, and the owning account must exist and not be locked. No
* Express or MeshCentral coupling: the services are injected and can be stubbed
* in tests.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const SITERIGHT_LOCKED = 0x00000020; // 32
const SITERIGHT_ADMIN = 0xFFFFFFFF;

/** True when the account carries the locked site right; admins are exempt. */
function isUserLocked(user) {
    return (user != null) && Boolean(user.siteadmin) && (user.siteadmin != SITERIGHT_ADMIN) && ((user.siteadmin & SITERIGHT_LOCKED) !== 0);
}

/**
* Assert that a services object can verify login tokens.
*
* Services:
*   getLoginToken(tokenUser)                  -> Promise<login token record|null>
*   hashPassword(password, salt)              -> Promise<stored hash string>
*   getUser(userid)                           -> Promise<user record|null>
*   clock()                                   -> milliseconds; defaults to Date.now
*/
function validateServices(services) {
    if (services == null) { throw new Error('Login token verification requires services.'); }
    if (typeof services.getLoginToken !== 'function') { throw new Error('Login token verification requires getLoginToken.'); }
    if (typeof services.hashPassword !== 'function') { throw new Error('Login token verification requires hashPassword.'); }
    if (typeof services.getUser !== 'function') { throw new Error('Login token verification requires getUser.'); }
}

/**
* Resolve a login-token credential pair to its record and owning user.
*
* Returns Promise<{ ok: true, loginToken, user } | { ok: false, reason }>
* where reason is 'invalid' (missing/expired record, password mismatch,
* missing user) or 'locked' (the user carries the locked site right, so the
* login form can say so). Errors from the services propagate so callers fail
* closed on their own terms.
*/
async function verifyLoginToken(services, credential) {
    validateServices(services);
    if ((credential == null) || (typeof credential.tokenUser !== 'string') || (typeof credential.tokenPass !== 'string')) { return { ok: false, reason: 'invalid' }; }

    const loginToken = await services.getLoginToken(credential.tokenUser);
    if (loginToken == null) { return { ok: false, reason: 'invalid' }; }

    const clock = (typeof services.clock === 'function') ? services.clock : Date.now;
    if ((loginToken.expire != 0) && (loginToken.expire < clock())) { return { ok: false, reason: 'invalid' }; }

    const hash = await services.hashPassword(credential.tokenPass, loginToken.salt);
    if (hash !== loginToken.hash) { return { ok: false, reason: 'invalid' }; }

    const user = await services.getUser(loginToken.userid);
    if (user == null) { return { ok: false, reason: 'invalid' }; }
    if (isUserLocked(user)) { return { ok: false, reason: 'locked' }; }

    return { ok: true, loginToken: loginToken, user: user };
}

module.exports = {
    SITERIGHT_LOCKED: SITERIGHT_LOCKED,
    isUserLocked: isUserLocked,
    validateServices: validateServices,
    verifyLoginToken: verifyLoginToken
};
