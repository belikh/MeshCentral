'use strict';

/**
 * Tests for bearer login-token authentication.
 *
 * The services are stubbed: no database, no hashing, no server. Values are
 * synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodeCredential } = require('../mcp-credential.js');
const { parseBearerCredential, createLoginTokenAuthenticator } = require('../mcp-auth.js');

const TOKEN_USER = '~t:SyntheticTokenUser';
const TOKEN_PASS = 'SyntheticTokenPass';
const CREDENTIAL = encodeCredential(TOKEN_USER, TOKEN_PASS);

function makeServices(overrides) {
    const state = {
        token: { _id: 'logintoken-' + TOKEN_USER, tokenUser: TOKEN_USER, userid: 'user//alpha', name: 'Agent laptop', salt: 'salt', hash: 'hash-ok', expire: 0 },
        user: { _id: 'user//alpha', name: 'Alpha', siteadmin: 0xFFFFFFFF },
        hash: 'hash-ok',
        hashError: null
    };
    return Object.assign({
        state,
        services: {
            async getLoginToken(tokenUser) { return (tokenUser === TOKEN_USER) ? state.token : null; },
            async hashPassword(password, salt) { if (state.hashError != null) { throw state.hashError; } return (password === TOKEN_PASS) ? state.hash : 'hash-bad'; },
            async getUser(userid) { return (state.user != null && userid === state.user._id) ? state.user : null; }
        }
    }, overrides || {});
}

function request(authorization) {
    return { headers: (authorization != null) ? { authorization: authorization } : {} };
}

test('the Authorization header parses only well-formed bearer credentials', () => {
    assert.deepEqual(parseBearerCredential('Bearer ' + CREDENTIAL), { tokenUser: TOKEN_USER, tokenPass: TOKEN_PASS });
    assert.deepEqual(parseBearerCredential('bearer ' + CREDENTIAL), { tokenUser: TOKEN_USER, tokenPass: TOKEN_PASS });
    assert.deepEqual(parseBearerCredential('  Bearer   ' + CREDENTIAL + '  '), { tokenUser: TOKEN_USER, tokenPass: TOKEN_PASS });
    assert.equal(parseBearerCredential(undefined), null);
    assert.equal(parseBearerCredential(null), null);
    assert.equal(parseBearerCredential(''), null);
    assert.equal(parseBearerCredential('Basic abc'), null);
    assert.equal(parseBearerCredential('Bearer'), null);
    assert.equal(parseBearerCredential('Bearer not-a-credential'), null);
    assert.equal(parseBearerCredential('Bearer ' + CREDENTIAL + ' extra'), null);
});

test('a valid credential resolves to the owning account', async () => {
    const { services } = makeServices();
    const authenticate = createLoginTokenAuthenticator(services);
    const account = await authenticate(request('Bearer ' + CREDENTIAL));
    assert.deepEqual(account, {
        userid: 'user//alpha',
        username: 'Alpha',
        tokenUser: TOKEN_USER,
        tokenPass: TOKEN_PASS,
        tokenName: 'Agent laptop'
    });
});

test('a missing or malformed header is rejected without touching the services', async () => {
    const { services } = makeServices();
    const authenticate = createLoginTokenAuthenticator(services);
    assert.equal(await authenticate(request(null)), null);
    assert.equal(await authenticate(request('Basic xyz')), null);
    assert.equal(await authenticate(null), null);
});

test('wrong password, unknown token and expired token are rejected', async () => {
    const { services, state } = makeServices();
    const authenticate = createLoginTokenAuthenticator(services);
    state.hash = 'different-hash';
    assert.equal(await authenticate(request('Bearer ' + CREDENTIAL)), null);
    state.hash = 'hash-ok';
    state.token = null;
    assert.equal(await authenticate(request('Bearer ' + CREDENTIAL)), null);
    state.token = { _id: 'logintoken-' + TOKEN_USER, tokenUser: TOKEN_USER, userid: 'user//alpha', salt: 'salt', hash: 'hash-ok', expire: 1 };
    assert.equal(await authenticate(request('Bearer ' + CREDENTIAL)), null);
});

test('a missing or locked account is rejected', async () => {
    const { services, state } = makeServices();
    const authenticate = createLoginTokenAuthenticator(services);
    state.user = null;
    assert.equal(await authenticate(request('Bearer ' + CREDENTIAL)), null);
    state.user = { _id: 'user//alpha', name: 'Alpha', siteadmin: 32 };
    assert.equal(await authenticate(request('Bearer ' + CREDENTIAL)), null);
});

test('service failures reject cleanly instead of throwing', async () => {
    const { services, state } = makeServices();
    const authenticate = createLoginTokenAuthenticator(services);
    state.hashError = new Error('hash failure');
    assert.equal(await authenticate(request('Bearer ' + CREDENTIAL)), null);
});

test('the authenticator requires its services', () => {
    assert.throws(() => createLoginTokenAuthenticator({}), /getLoginToken/);
    assert.throws(() => createLoginTokenAuthenticator({ getLoginToken: async () => null }), /hashPassword/);
});
