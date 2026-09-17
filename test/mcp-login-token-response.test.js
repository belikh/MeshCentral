'use strict';

/**
 * Tests for the createLoginToken command response.
 *
 * The response carries the login-token pair and the derived MCP connection
 * credential; every value here is synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeCredential } = require('../mcp-credential.js');
const { createLoginTokenResponse } = require('../mcp-login-token-response.js');

const TOKEN_USER = '~t:AbCdEf0123456789/xYz==';
const TOKEN_PASS = 'PaSs+word/1234=';

test('the creation response carries the credential and no secret material', () => {
    const response = createLoginTokenResponse('Agent laptop', TOKEN_USER, TOKEN_PASS, 1700000000000, 0);
    assert.equal(response.action, 'createLoginToken');
    assert.equal(response.name, 'Agent laptop');
    assert.equal(response.tokenUser, TOKEN_USER);
    assert.equal(response.tokenPass, TOKEN_PASS);
    assert.equal(response.created, 1700000000000);
    assert.equal(response.expire, 0);
    assert.deepEqual(decodeCredential(response.mcpToken), { tokenUser: TOKEN_USER, tokenPass: TOKEN_PASS });
    assert.equal('salt' in response, false);
    assert.equal('hash' in response, false);
});
