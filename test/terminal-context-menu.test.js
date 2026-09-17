'use strict';

/**
 * Tests for the terminal context-menu restriction.
 *
 * The domain setting terminal.contextMenu decides which shell protocols the
 * relay may launch. The decision is a pure predicate shared by the relay and
 * the web UI, so these tests need no sockets and no live server: the relay
 * entry point is exercised with a fake websocket only to prove that it really
 * consults the predicate before counting the session.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    TERMINAL_MENU_ALL,
    TERMINAL_MENU_ADMIN,
    TERMINAL_MENU_USER,
    TERMINAL_MENU_ASK,
    getTerminalMenuMask,
    getTerminalProtocolClass,
    isTerminalProtocolAllowed
} = require('../terminal-context-menu.js');
const meshRelay = require('../meshrelay.js');

const SHELL_PROTOCOLS = [1, 6, 7, 8, 9];
const NON_SHELL_PROTOCOLS = [0, 2, 3, 4, 5, 10, 11, 12, 13, 14, 100, 101, 200, -1, NaN];

function domainWith(setting) {
    return { terminal: { contextmenu: setting } };
}

function classify(protocol) {
    const protocolClass = getTerminalProtocolClass(protocol);
    if (protocolClass == null) { return null; }
    return (protocolClass == 'admin') ? TERMINAL_MENU_ADMIN : TERMINAL_MENU_USER;
}

test('an absent terminal menu setting keeps the documented default of every shell', () => {
    for (const domain of [undefined, null, {}, { terminal: undefined }, { terminal: null }, { terminal: {} }]) {
        assert.equal(getTerminalMenuMask(domain), TERMINAL_MENU_ALL);
        for (const protocol of SHELL_PROTOCOLS) {
            assert.equal(isTerminalProtocolAllowed(domain, protocol), true, 'protocol ' + protocol);
        }
    }
});

test('the all entry enables admin, user and ask', () => {
    for (const setting of [['all'], ['ALL'], ['  All  '], ['all', 'admin'], 'all', ' ALL ']) {
        assert.equal(getTerminalMenuMask(domainWith(setting)), TERMINAL_MENU_ALL, JSON.stringify(setting));
    }
});

test('admin, user and ask entries map to their menu bits', () => {
    assert.equal(getTerminalMenuMask(domainWith(['admin'])), TERMINAL_MENU_ADMIN);
    assert.equal(getTerminalMenuMask(domainWith(['user'])), TERMINAL_MENU_USER);
    assert.equal(getTerminalMenuMask(domainWith(['ask'])), TERMINAL_MENU_ASK);
    assert.equal(getTerminalMenuMask(domainWith(['admin', 'user'])), TERMINAL_MENU_ADMIN | TERMINAL_MENU_USER);
    assert.equal(getTerminalMenuMask(domainWith(['admin', 'ask'])), TERMINAL_MENU_ADMIN | TERMINAL_MENU_ASK);
    assert.equal(getTerminalMenuMask(domainWith(['user', 'ask'])), TERMINAL_MENU_USER | TERMINAL_MENU_ASK);
    assert.equal(getTerminalMenuMask(domainWith(['admin', 'user', 'ask'])), TERMINAL_MENU_ALL);
});

test('case and surrounding whitespace are normalised', () => {
    assert.equal(getTerminalMenuMask(domainWith([' Admin '])), TERMINAL_MENU_ADMIN);
    assert.equal(getTerminalMenuMask(domainWith(['\tUSER\n'])), TERMINAL_MENU_USER);
    assert.equal(getTerminalMenuMask(domainWith('ASK')), TERMINAL_MENU_ASK);
    assert.equal(getTerminalMenuMask(domainWith([' Admin ', ' user '])), TERMINAL_MENU_ADMIN | TERMINAL_MENU_USER);
});

test('a string setting is treated as a one-entry list', () => {
    assert.equal(getTerminalMenuMask(domainWith('admin')), TERMINAL_MENU_ADMIN);
    assert.equal(getTerminalMenuMask(domainWith('all')), TERMINAL_MENU_ALL);
    assert.equal(getTerminalMenuMask(domainWith('banana')), 0);
});

test('the lowercased and camelCase keys are both read, lowercase first', () => {
    assert.equal(getTerminalMenuMask({ terminal: { contextMenu: ['admin'] } }), TERMINAL_MENU_ADMIN);
    assert.equal(getTerminalMenuMask({ terminal: { contextmenu: ['user'], contextMenu: ['admin'] } }), TERMINAL_MENU_USER);
    assert.equal(getTerminalMenuMask({ terminal: { contextMenu: ['ask'] } }), TERMINAL_MENU_ASK);
});

test('an empty or unrecognised setting denies every shell', () => {
    for (const setting of [[], [''], ['   '], ['banana'], ['ADMIN-SHELL'], ['rooot'], ['alll']]) {
        const domain = domainWith(setting);
        assert.equal(getTerminalMenuMask(domain), 0, JSON.stringify(setting));
        for (const protocol of SHELL_PROTOCOLS) {
            assert.equal(isTerminalProtocolAllowed(domain, protocol), false, JSON.stringify(setting) + ' protocol ' + protocol);
        }
    }
});

test('a malformed setting denies every shell', () => {
    for (const setting of [42, 0, true, false, {}, { admin: true }]) {
        const domain = domainWith(setting);
        assert.equal(getTerminalMenuMask(domain), 0, JSON.stringify(setting));
        for (const protocol of SHELL_PROTOCOLS) {
            assert.equal(isTerminalProtocolAllowed(domain, protocol), false, JSON.stringify(setting) + ' protocol ' + protocol);
        }
    }
});

test('non-string list entries are ignored rather than trusted', () => {
    assert.equal(getTerminalMenuMask(domainWith(['admin', 1, null, undefined, {}, ['user']])), TERMINAL_MENU_ADMIN);
    assert.equal(getTerminalMenuMask(domainWith([1, null, {}, ['admin']])), 0);
});

test('protocols outside the shell set are unaffected by the menu', () => {
    for (const domain of [domainWith([]), domainWith(['banana']), domainWith(['admin'])]) {
        for (const protocol of NON_SHELL_PROTOCOLS) {
            assert.equal(isTerminalProtocolAllowed(domain, protocol), true, 'protocol ' + protocol);
        }
    }
});

test('protocol 7 is gated as a user shell', () => {
    assert.equal(getTerminalProtocolClass(7), 'user');
    assert.equal(isTerminalProtocolAllowed(domainWith(['admin']), 7), false);
    assert.equal(isTerminalProtocolAllowed(domainWith(['ask']), 7), false);
    assert.equal(isTerminalProtocolAllowed(domainWith([]), 7), false);
    assert.equal(isTerminalProtocolAllowed(domainWith(['user']), 7), true);
    assert.equal(isTerminalProtocolAllowed(domainWith(['user', 'ask']), 7), true);
});

test('shell protocols are classified as admin or user for the menu', () => {
    assert.equal(getTerminalProtocolClass(1), 'admin');
    assert.equal(getTerminalProtocolClass(6), 'admin');
    assert.equal(getTerminalProtocolClass(8), 'user');
    assert.equal(getTerminalProtocolClass(9), 'user');
    for (const protocol of NON_SHELL_PROTOCOLS) {
        assert.equal(getTerminalProtocolClass(protocol), null, 'protocol ' + protocol);
    }
});

test('the UI mask and the relay predicate agree on every shell protocol', () => {
    const settings = [undefined, ['all'], ['admin'], ['user'], ['ask'], ['admin', 'user'], ['admin', 'ask'], ['user', 'ask'], [], [''], ['banana'], 42, {}];
    for (const setting of settings) {
        const domain = (setting === undefined) ? {} : domainWith(setting);
        const mask = getTerminalMenuMask(domain);
        for (const protocol of SHELL_PROTOCOLS) {
            const bit = classify(protocol);
            const expected = (mask & bit) !== 0;
            assert.equal(isTerminalProtocolAllowed(domain, protocol), expected, JSON.stringify(setting) + ' protocol ' + protocol);
        }
    }
});

test('the terminal menu markup classifies every shell like the relay predicate', () => {
    const views = [
        { name: 'default.handlebars', path: path.join(__dirname, '..', 'views', 'default.handlebars'), items: 13 },
        { name: 'default3.handlebars', path: path.join(__dirname, '..', 'views', 'default3.handlebars'), items: 13 }
    ];
    for (const view of views) {
        const source = fs.readFileSync(view.path, 'utf8');
        const menuItem = /class="([^"]*)"\s+onclick="cmtermaction\((\d+),(0x[0-9a-fA-F]+|\d+),event\)"/g;
        let match = null, items = 0;
        while ((match = menuItem.exec(source)) != null) {
            items++;
            const termClass = (match[1].match(/(term-(?:ask-)?(?:admin|user))/) || [])[1];
            const action = parseInt(match[2]);
            const consent = parseInt(match[3]);
            const launchedProtocol = (action == 100) ? 1 : action; // A login shell is terminal protocol 1
            const protocolClass = getTerminalProtocolClass(launchedProtocol);
            assert.notEqual(protocolClass, null, view.name + ' cmtermaction(' + action + '...) is not a shell protocol');
            const expected = 'term-' + (((consent & 0x10) != 0) ? 'ask-' : '') + protocolClass;
            assert.equal(termClass, expected, view.name + ' cmtermaction(' + match[2] + ',' + match[3] + ')');
        }
        assert.equal(items, view.items, view.name + ' terminal menu items');
    }
});

test('the web page and the relay both read the mask from the shared predicate', () => {
    const root = path.join(__dirname, '..');
    const webserver = fs.readFileSync(path.join(root, 'webserver.js'), 'utf8');
    const relay = fs.readFileSync(path.join(root, 'meshrelay.js'), 'utf8');
    assert.match(webserver, /xargs\.termMenu = obj\.terminalContextMenu\.getTerminalMenuMask\(domain\);/);
    assert.match(relay, /terminalContextMenu\.isTerminalProtocolAllowed\(domain, requestedProtocol\)/);
    for (const view of ['default.handlebars', 'default3.handlebars']) {
        const source = fs.readFileSync(path.join(root, 'views', view), 'utf8');
        assert.match(source, /var termMenu = parseInt\('\{\{\{termMenu\}\}\}'\);/);
    }
});

function createRelayHarness(query) {
    const closes = [];
    const debug = [];
    const parent = {
        relaySessionCount: 0,
        parent: { debug: (source, message) => { debug.push({ source: source, message: message }); } }
    };
    const ws = { close: () => { closes.push(true); } };
    const req = { query: Object.assign({}, query), clientIp: '127.0.0.1' };
    const user = { _id: 'user//test', name: 'test' };
    return { parent: parent, ws: ws, req: req, user: user, closes: closes, debug: debug };
}

test('the relay refuses a shell protocol the domain disables', (t) => {
    const logMock = t.mock.method(console, 'log');
    const domain = domainWith(['user']);
    const h = createRelayHarness({ p: '1' });
    meshRelay.CreateMeshRelay(h.parent, h.ws, h.req, domain, h.user, null);
    assert.equal(h.closes.length, 1);
    assert.equal(h.parent.relaySessionCount, 0);
    assert.equal(h.debug.length, 1);
    assert.equal(h.debug[0].source, 'relay');
    assert.match(h.debug[0].message, /denied by domain terminal\.contextMenu/);
    assert.equal(logMock.mock.calls.length, 0);
});

test('the relay refuses protocol 7 when only admin shells are enabled', () => {
    const domain = domainWith(['admin']);
    const h = createRelayHarness({ p: '7' });
    meshRelay.CreateMeshRelay(h.parent, h.ws, h.req, domain, h.user, null);
    assert.equal(h.closes.length, 1);
    assert.equal(h.parent.relaySessionCount, 0);
});

test('the relay applies the cookie protocol before the gate', () => {
    const domain = domainWith([]);
    const h = createRelayHarness({});
    meshRelay.CreateMeshRelay(h.parent, h.ws, h.req, domain, h.user, { p: 8 });
    assert.equal(h.req.query.p, 8);
    assert.equal(h.closes.length, 1);
    assert.equal(h.parent.relaySessionCount, 0);
});
