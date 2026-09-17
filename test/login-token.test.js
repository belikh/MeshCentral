'use strict';

/**
 * Tests for the shared login-token verifier.
 *
 * The services are stubbed: no database, no hashing, no server. Values are
 * synthetic and the clock is fixed so expiry is deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { SITERIGHT_LOCKED, isUserLocked, validateServices, verifyLoginToken } = require('../login-token.js');

const TOKEN_USER = '~t:SyntheticTokenUser';
const TOKEN_PASS = 'SyntheticTokenPass';
const CREDENTIAL = { tokenUser: TOKEN_USER, tokenPass: TOKEN_PASS };

function makeServices() {
    const state = {
        token: { _id: 'logintoken-' + TOKEN_USER, tokenUser: TOKEN_USER, userid: 'user//alpha', name: 'Agent laptop', salt: 'salt', hash: 'hash-ok', expire: 0 },
        user: { _id: 'user//alpha', name: 'Alpha', siteadmin: 0 },
        hash: 'hash-ok',
        hashError: null,
        now: 1000
    };
    return {
        state,
        services: {
            async getLoginToken(tokenUser) { return (tokenUser === TOKEN_USER) ? state.token : null; },
            async hashPassword(password, salt) { if (state.hashError != null) { throw state.hashError; } return (password === TOKEN_PASS) ? state.hash : 'hash-bad'; },
            async getUser(userid) { return (state.user != null && userid === state.user._id) ? state.user : null; },
            clock() { return state.now; }
        }
    };
}

test('a valid credential resolves to the record and the owning user', async () => {
    const { services, state } = makeServices();
    assert.deepEqual(await verifyLoginToken(services, CREDENTIAL), { loginToken: state.token, user: state.user });
});

test('wrong password, unknown token and expired token are rejected', async () => {
    const { services, state } = makeServices();
    state.hash = 'different-hash';
    assert.equal(await verifyLoginToken(services, CREDENTIAL), null);
    state.hash = 'hash-ok';
    state.token = null;
    assert.equal(await verifyLoginToken(services, CREDENTIAL), null);
    state.token = { _id: 'logintoken-' + TOKEN_USER, tokenUser: TOKEN_USER, userid: 'user//alpha', name: 'Agent laptop', salt: 'salt', hash: 'hash-ok', expire: 999 };
    assert.equal(await verifyLoginToken(services, CREDENTIAL), null);
});

test('the injected clock decides expiry and expire 0 never expires', async () => {
    const { services, state } = makeServices();
    state.token.expire = 1001;
    assert.deepEqual(await verifyLoginToken(services, CREDENTIAL), { loginToken: state.token, user: state.user });
    state.token.expire = 1000;
    assert.deepEqual(await verifyLoginToken(services, CREDENTIAL), { loginToken: state.token, user: state.user });
    state.token.expire = 999;
    assert.equal(await verifyLoginToken(services, CREDENTIAL), null);
    state.token.expire = 0;
    state.now = Number.MAX_SAFE_INTEGER;
    assert.deepEqual(await verifyLoginToken(services, CREDENTIAL), { loginToken: state.token, user: state.user });
});

test('a missing or locked account is rejected', async () => {
    const { services, state } = makeServices();
    state.user = null;
    assert.equal(await verifyLoginToken(services, CREDENTIAL), null);
    const { services: second, state: secondState } = makeServices();
    secondState.user = { _id: 'user//alpha', name: 'Alpha', siteadmin: SITERIGHT_LOCKED };
    assert.equal(await verifyLoginToken(second, CREDENTIAL), null);
});

test('the locked site right is named and admins are exempt', () => {
    assert.equal(SITERIGHT_LOCKED, 32);
    assert.equal(isUserLocked({ siteadmin: SITERIGHT_LOCKED }), true);
    assert.equal(isUserLocked({ siteadmin: 1 | SITERIGHT_LOCKED }), true);
    assert.equal(isUserLocked({ siteadmin: 0xFFFFFFFF }), false);
    assert.equal(isUserLocked({ siteadmin: 1 }), false);
    assert.equal(isUserLocked({ siteadmin: 0 }), false);
    assert.equal(isUserLocked({}), false);
    assert.equal(isUserLocked(null), false);
});

test('a malformed credential is rejected without touching the services', async () => {
    const { services } = makeServices();
    assert.equal(await verifyLoginToken(services, null), null);
    assert.equal(await verifyLoginToken(services, {}), null);
    assert.equal(await verifyLoginToken(services, { tokenUser: TOKEN_USER }), null);
    assert.equal(await verifyLoginToken(services, { tokenPass: TOKEN_PASS }), null);
});

test('service failures propagate so callers can fail closed', async () => {
    const { services, state } = makeServices();
    state.hashError = new Error('hash failure');
    await assert.rejects(verifyLoginToken(services, CREDENTIAL), /hash failure/);
});

test('the verifier requires its services', async () => {
    assert.throws(() => validateServices(null), /services/);
    assert.throws(() => validateServices({}), /getLoginToken/);
    assert.throws(() => validateServices({ getLoginToken: async () => null }), /hashPassword/);
    assert.throws(() => validateServices({ getLoginToken: async () => null, hashPassword: async () => null }), /getUser/);
    await assert.rejects(verifyLoginToken({}, CREDENTIAL), /getLoginToken/);
});
