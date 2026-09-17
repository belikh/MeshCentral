'use strict';

/**
* @description The MeshCentral createLoginToken command response.
*
* Creating a login token reveals the token username and password exactly once;
* this response adds the connection credential an MCP client uses as one
* string. The credential encoding itself lives in mcp-credential.js.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { encodeCredential } = require('./mcp-credential.js');

/** Build the createLoginToken response, with the MCP connection credential. */
function createLoginTokenResponse(name, tokenUser, tokenPass, created, expire) {
    return {
        action: 'createLoginToken',
        name: name,
        tokenUser: tokenUser,
        tokenPass: tokenPass,
        mcpToken: encodeCredential(tokenUser, tokenPass),
        created: created,
        expire: expire
    };
}

module.exports = {
    createLoginTokenResponse: createLoginTokenResponse
};
