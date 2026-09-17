'use strict';

/**
 * Tests for the MCP connection credential codec.
 *
 * The credential wraps a MeshCentral login token pair
 * (`~t:` username plus a base64 password) in one string:
 * `mt_<base64url(tokenUser + ':' + tokenPass)>`. Every value here is
 * synthetic; no real token or server is involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pass = require('../pass.js');
const {
    PREFIX,
    CredentialError,
    encodeCredential,
    decodeCredential
} = require('../mcp-credential.js');

const TOKEN_USER = '~t:AbCdEf0123456789/xYz==';
const TOKEN_PASS = 'PaSs+word/1234=';

function hashWithSalt(password, salt) {
    return new Promise((resolve, reject) => {
        pass.hash(password, salt, (error, hash, tag) => {
            if (error) { reject(error); return; }
            resolve({ hash, tag });
        }, 0);
    });
}

test('a credential round-trips the token pair exactly', () => {
    const credential = encodeCredential(TOKEN_USER, TOKEN_PASS);
    assert.equal(credential.startsWith(PREFIX), true);
    assert.deepEqual(decodeCredential(credential), { tokenUser: TOKEN_USER, tokenPass: TOKEN_PASS });
});

test('the codec handles base64 punctuation in both parts', () => {
    const user = '~t:plain';
    const secret = 'Ab+C/D==';
    assert.deepEqual(decodeCredential(encodeCredential(user, secret)), { tokenUser: user, tokenPass: secret });
});

test('encoding requires both parts', () => {
    assert.throws(() => encodeCredential('', 'x'), CredentialError);
    assert.throws(() => encodeCredential('~t:x', ''), CredentialError);
    assert.throws(() => encodeCredential(null, 'x'), CredentialError);
    assert.throws(() => encodeCredential('~t:x', null), CredentialError);
});

test('decoding rejects non-strings, wrong prefixes and empty bodies', () => {
    assert.throws(() => decodeCredential(null), (error) => (error instanceof CredentialError) && (error.code === 'E_FORMAT'));
    assert.throws(() => decodeCredential('xyz'), (error) => error.code === 'E_PREFIX');
    assert.throws(() => decodeCredential(PREFIX), (error) => error.code === 'E_ENCODING');
    assert.throws(() => decodeCredential(PREFIX + 'not*base64'), (error) => error.code === 'E_ENCODING');
    assert.throws(() => decodeCredential(PREFIX + 'cGFkZGluZw=='), (error) => error.code === 'E_ENCODING');
    assert.throws(() => decodeCredential(PREFIX + 'A'), (error) => error.code === 'E_ENCODING');
});

test('decoding rejects malformed pairs', () => {
    const separate = (text) => PREFIX + Buffer.from(text, 'utf8').toString('base64url');
    assert.throws(() => decodeCredential(separate('nocolon')), (error) => error.code === 'E_FORMAT');
    assert.throws(() => decodeCredential(separate(':onlypass')), (error) => error.code === 'E_FORMAT');
    assert.throws(() => decodeCredential(separate('onlyuser:')), (error) => error.code === 'E_FORMAT');
});

test('the decoded password still verifies against the stored hash', async () => {
    // Same shape the login path uses: hash(pass, salt) must equal the stored hash.
    const stored = await new Promise((resolve, reject) => {
        pass.hash(TOKEN_PASS, (error, salt, hash, tag) => {
            if (error) { reject(error); return; }
            resolve({ salt, hash, tag });
        });
    });
    const decoded = decodeCredential(encodeCredential(TOKEN_USER, TOKEN_PASS));
    const verified = await hashWithSalt(decoded.tokenPass, stored.salt);
    assert.equal(verified.hash, stored.hash);
    const wrong = await hashWithSalt('not-the-password', stored.salt);
    assert.notEqual(wrong.hash, stored.hash);
});
