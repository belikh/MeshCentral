'use strict';

/**
 * Source-address policy for new agent enrolment.
 *
 * The policy gates only nodes whose key is not yet known: the server list and
 * the domain list compose with AND, file: entries resolve through the shared
 * IP-list reader, and a configured value that is not an array of addresses
 * denies with a message rather than passing silently. The agent connection
 * gate calls the same predicate, so these decisions are the ones the gate
 * makes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../agent-enrolment-policy.js');

/** A log function that keeps every message it is given. */
function recorder() {
    const messages = [];
    return { messages: messages, log: function (message) { messages.push(message); } };
}

test('a new agent is allowed when neither list is configured', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('203.0.113.9', false, undefined, undefined, capture.log), true);
    assert.equal(policy.isNewAgentAllowed('203.0.113.9', false, null, null, capture.log), true);
    assert.deepEqual(capture.messages, []);
});

test('a new agent is allowed when both configured lists match', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('10.1.2.3', false, ['10.0.0.0/8'], ['10.1.0.0/16'], capture.log), true);
    assert.deepEqual(capture.messages, []);
});

test('an address outside the server list is denied', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('192.168.1.10', false, ['10.0.0.0/8'], undefined, capture.log), false);
    assert.deepEqual(capture.messages, []);
});

test('an address outside the domain list is denied', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('192.168.1.10', false, undefined, ['10.0.0.0/8'], capture.log), false);
    assert.deepEqual(capture.messages, []);
});

test('the server and domain lists compose with AND', function () {
    // Server matches, domain does not.
    assert.equal(policy.isNewAgentAllowed('10.1.2.3', false, ['10.0.0.0/8'], ['192.168.0.0/16']), false);
    // Domain matches, server does not.
    assert.equal(policy.isNewAgentAllowed('10.1.2.3', false, ['192.168.0.0/16'], ['10.0.0.0/8']), false);
    // Neither matches.
    assert.equal(policy.isNewAgentAllowed('172.16.0.1', false, ['10.0.0.0/8'], ['192.168.0.0/16']), false);
});

test('an existing node bypasses both lists', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('203.0.113.9', true, ['10.0.0.0/8'], ['192.168.0.0/16'], capture.log), true);
    assert.deepEqual(capture.messages, []);
});

test('an existing node bypasses a malformed list without logging', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('203.0.113.9', true, 42, 'nonsense', capture.log), true);
    assert.deepEqual(capture.messages, []);
});

test('CIDR and bare addresses both match', function () {
    assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, ['10.0.0.0/8'], undefined), true);
    assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, ['10.0.0.5'], undefined), true);
    assert.equal(policy.isNewAgentAllowed('10.0.0.6', false, ['10.0.0.5'], undefined), false);
    assert.equal(policy.isNewAgentAllowed('::1', false, ['::1'], undefined), true);
});

test('a non-array server value denies with a message', function () {
    for (const value of [42, 'nonsense', {}, true]) {
        const capture = recorder();
        assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, value, undefined, capture.log), false);
        assert.equal(capture.messages.length, 1);
        assert.match(capture.messages[0], /agentAllowedIPNewAgents/);
        assert.match(capture.messages[0], /server/);
        assert.match(capture.messages[0], /10\.0\.0\.5/);
    }
});

test('a non-array domain value denies with a message', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, undefined, ['10.0.0.0/8', 'extra'], capture.log), true);
    assert.deepEqual(capture.messages, []);

    const bad = recorder();
    assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, undefined, 12, bad.log), false);
    assert.equal(bad.messages.length, 1);
    assert.match(bad.messages[0], /agentAllowedIPNewAgents/);
    assert.match(bad.messages[0], /domain/);
});

test('an array with a non-string entry denies with a message', function () {
    const capture = recorder();
    assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, ['10.0.0.0/8', 42], undefined, capture.log), false);
    assert.equal(capture.messages.length, 1);
    assert.match(capture.messages[0], /agentAllowedIPNewAgents/);
});

test('an empty array denies, matching the existing allow-list gate', function () {
    assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, [], undefined), false);
});

test('isResolvableIpList accepts arrays of non-empty strings only', function () {
    assert.equal(policy.isResolvableIpList(undefined), false);
    assert.equal(policy.isResolvableIpList(null), false);
    assert.equal(policy.isResolvableIpList('10.0.0.0/8'), false);
    assert.equal(policy.isResolvableIpList(42), false);
    assert.equal(policy.isResolvableIpList(['10.0.0.0/8', 'example.com']), true);
    assert.equal(policy.isResolvableIpList(['10.0.0.0/8', 42]), false);
    assert.equal(policy.isResolvableIpList(['10.0.0.0/8', '']), false);
});

test('file: entries resolve with the existing list semantics', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-enrolment-'));
    try {
        fs.writeFileSync(path.join(dir, 'agents.txt'), '# allowed networks\n\n192.168.1.0/24\n10.0.0.5 # office\nnot-an-ip\nuser@example.com\n');
        const list = policy.readIpListFromFile('file:agents.txt', dir);
        assert.deepEqual(list, ['192.168.1.0/24', '10.0.0.5']);
        assert.equal(policy.isNewAgentAllowed('10.0.0.5', false, list, undefined), true);
        assert.equal(policy.isNewAgentAllowed('10.0.0.6', false, list, undefined), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a value that is not a file: entry passes through untouched', function () {
    assert.equal(policy.readIpListFromFile('10.0.0.0/8', '/nowhere'), '10.0.0.0/8');
    assert.deepEqual(policy.readIpListFromFile(['10.0.0.0/8'], '/nowhere'), ['10.0.0.0/8']);
});

test('an unreadable file: entry resolves to null as for the existing lists', function () {
    assert.equal(policy.readIpListFromFile('file:missing-enrolment-list.txt', '/nowhere'), null);
});
