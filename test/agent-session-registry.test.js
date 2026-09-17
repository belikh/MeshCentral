'use strict';

/**
 * Tests for the node agent session registry.
 *
 * The registry is the seam between meshagent.js and the websocket: it decides
 * which agent object is the live session for a node, and whether a closing
 * session may detach that entry. These tests drive the real supersede and
 * close lifecycle against a fake connectivity map, so the stale session's
 * close goes through the production detach rule instead of a hand-simulated
 * clear. No websockets and no live agents.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { completeSession, detachSession, registerSession } = require('../agent-session-registry.js');

const NODE_KEY = 'node/domain1/abc123';

// The server side of a session lifecycle: the wsagents entry, a connectivity
// map keyed by node, and the fake agents. A fake agent's close runs the
// production detach rule, like obj.close does: only the session that still
// owns the entry may remove it and clear connectivity.
function createServer() {
    const wsagents = {};
    const connectivity = new Map();
    const closed = [];
    const setCalls = [];

    function makeAgent(name, connectTime) {
        return {
            name,
            connectTime,
            close(arg) {
                closed.push({ name: this.name, arg });
                if (detachSession(wsagents, NODE_KEY, this) === true) { connectivity.delete(NODE_KEY); }
            }
        };
    }

    function connect(agent) {
        completeSession(wsagents, NODE_KEY, agent, {
            onSuperseded(superseded) { superseded.close(3); },
            setConnectivity(session) {
                setCalls.push({ name: session.name, connectTime: session.connectTime });
                connectivity.set(NODE_KEY, session.connectTime);
            }
        });
    }

    return {
        wsagents,
        connectivity,
        closed,
        setCalls,
        makeAgent,
        connect,
        clearThroughClose(agent) { agent.close(0); },
        isOnline() { return connectivity.has(NODE_KEY); },
        owner() { return wsagents[NODE_KEY]; }
    };
}

test('the first session registers and sets connectivity', () => {
    const server = createServer();
    const first = server.makeAgent('first', 1000);

    server.connect(first);

    assert.equal(server.owner(), first);
    assert.equal(server.isOnline(), true);
    assert.equal(server.connectivity.get(NODE_KEY), 1000);
    assert.deepEqual(server.closed, []);
    assert.deepEqual(server.setCalls, [{ name: 'first', connectTime: 1000 }]);
});

test('a duplicate session supersedes the entry, closes the old session with 3 and re-affirms connectivity from the new session', () => {
    const server = createServer();
    const first = server.makeAgent('first', 1000);
    server.connect(first);

    let ownerWhenClosed = null;
    let ownerSeenBySuperseded = null;
    const second = server.makeAgent('second', 2000);
    completeSession(server.wsagents, NODE_KEY, second, {
        onSuperseded(superseded) {
            ownerWhenClosed = server.owner();
            superseded.close(3);
            ownerSeenBySuperseded = server.owner();
        },
        setConnectivity(session) { server.connectivity.set(NODE_KEY, session.connectTime); }
    });

    // The registry entry is replaced before the superseded session is closed,
    // so its close cannot detach the superseding session.
    assert.equal(ownerSeenBySuperseded, second);
    assert.equal(ownerWhenClosed, second);
    assert.deepEqual(server.closed, [{ name: 'first', arg: 3 }]);
    assert.equal(server.owner(), second);
    assert.equal(server.connectivity.get(NODE_KEY), 2000);
    assert.equal(server.isOnline(), true);
});

test('a late close from the superseded session neither detaches the new session nor clears its connectivity', () => {
    const server = createServer();
    const first = server.makeAgent('first', 1000);
    server.connect(first);

    const second = server.makeAgent('second', 2000);
    server.connect(second);

    // The superseded socket's close event arrives after the takeover.
    server.clearThroughClose(first);

    assert.equal(server.owner(), second);
    assert.equal(server.isOnline(), true);
    assert.equal(server.connectivity.get(NODE_KEY), 2000);

    // The live session's own close does detach and clear.
    server.clearThroughClose(second);
    assert.equal(server.owner(), undefined);
    assert.equal(server.isOnline(), false);
});

test('superseding an entry whose connectivity is already cleared sets it again', () => {
    const server = createServer();
    // A stale entry can outlive the connectivity it set: the socket is gone
    // (so no close ever detaches it) while the node is reported offline.
    const stale = server.makeAgent('stale', 500);
    registerSession(server.wsagents, NODE_KEY, stale);
    assert.equal(server.isOnline(), false);

    const fresh = server.makeAgent('fresh', 3000);
    server.connect(fresh);

    assert.equal(server.owner(), fresh);
    assert.equal(server.isOnline(), true);
    assert.equal(server.connectivity.get(NODE_KEY), 3000);
    assert.deepEqual(server.closed, [{ name: 'stale', arg: 3 }]);
});

test('repeated supersedes stay online and keep the latest connect time', () => {
    const server = createServer();
    server.connect(server.makeAgent('one', 100));
    assert.equal(server.isOnline(), true);

    server.connect(server.makeAgent('two', 200));

    // Idempotent when connectivity is already set: still online, updated time.
    assert.equal(server.isOnline(), true);
    assert.equal(server.connectivity.get(NODE_KEY), 200);

    server.connect(server.makeAgent('three', 300));
    assert.equal(server.isOnline(), true);
    assert.equal(server.connectivity.get(NODE_KEY), 300);
    assert.equal(server.closed.length, 2);
});
