'use strict';

/**
 * Tests for the command rights shared by the user command routing.
 *
 * Desktop View Only grants a remote session but not the ability to act on the
 * device, so a set of msg command types requires the non-right
 * MESHRIGHT_REMOTEVIEWONLY. The admin exemption is part of the same predicate
 * the routing consults, so deny for view-only and allow for admin are pinned
 * without a live server. This is a deliberate tightening: existing view-only
 * users lose these command types.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MESHRIGHT_ADMIN,
    MESHRIGHT_REMOTEVIEWONLY,
    VIEW_ONLY_FORBIDDEN_COMMAND_TYPES,
    isDeniedByNonRights,
    requiredNonRightsForMsg
} = require('../meshuser-command-rights.js');

const MESHRIGHT_REMOTECONTROL = 0x00000008;
const MESHRIGHT_NOTERMINAL = 0x00000200;

test('the view-only forbidden set is exactly the command types that act on the device', () => {
    assert.deepEqual([...VIEW_ONLY_FORBIDDEN_COMMAND_TYPES].sort(), [
        'alertbox',
        'deskBackground',
        'getclip',
        'localapp',
        'messagebox',
        'openUrl',
        'pskill',
        'serviceRestart',
        'serviceStart',
        'serviceStop',
        'setclip',
        'userSessions'
    ]);
});

test('every forbidden command type requires the view-only non-right', () => {
    for (const type of VIEW_ONLY_FORBIDDEN_COMMAND_TYPES) {
        assert.equal(requiredNonRightsForMsg(type), MESHRIGHT_REMOTEVIEWONLY, type);
    }
});

test('other command types carry no view-only non-right', () => {
    // toast and runcommands are governed by their own separate rights.
    for (const type of ['tunnel', 'toast', 'runcommands', 'console', '', null, undefined]) {
        assert.equal(requiredNonRightsForMsg(type), null);
    }
});

test('view-only users are denied every forbidden command type', () => {
    for (const type of VIEW_ONLY_FORBIDDEN_COMMAND_TYPES) {
        const requiredNonRights = requiredNonRightsForMsg(type);
        assert.equal(isDeniedByNonRights(MESHRIGHT_REMOTEVIEWONLY, requiredNonRights), true, type);
    }
});

test('admin is allowed every forbidden command type', () => {
    for (const type of VIEW_ONLY_FORBIDDEN_COMMAND_TYPES) {
        const requiredNonRights = requiredNonRightsForMsg(type);
        assert.equal(isDeniedByNonRights(MESHRIGHT_ADMIN, requiredNonRights), false, type);
    }
});

test('users without the view-only right are unaffected', () => {
    for (const type of VIEW_ONLY_FORBIDDEN_COMMAND_TYPES) {
        const requiredNonRights = requiredNonRightsForMsg(type);
        assert.equal(isDeniedByNonRights(MESHRIGHT_REMOTECONTROL, requiredNonRights), false, type);
    }
});

test('the view-only right denies even when held alongside remote control', () => {
    const rights = MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEWONLY;
    assert.equal(isDeniedByNonRights(rights, requiredNonRightsForMsg('getclip')), true);
});

test('the predicate preserves the other non-right checks', () => {
    assert.equal(isDeniedByNonRights(MESHRIGHT_NOTERMINAL, MESHRIGHT_NOTERMINAL), true);
    assert.equal(isDeniedByNonRights(MESHRIGHT_NOTERMINAL, MESHRIGHT_REMOTEVIEWONLY), false);
    assert.equal(isDeniedByNonRights(MESHRIGHT_REMOTEVIEWONLY, MESHRIGHT_NOTERMINAL), false);
    assert.equal(isDeniedByNonRights(MESHRIGHT_ADMIN, MESHRIGHT_NOTERMINAL), false);
    assert.equal(isDeniedByNonRights(0, null), false);
    assert.equal(isDeniedByNonRights(0, undefined), false);
});
