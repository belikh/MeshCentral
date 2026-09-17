'use strict';

/**
 * @description Node agent session registry.
 *
 * `wsagents[nodeKey]` is the live agent session for a node. A new session
 * takes the entry over before the superseded session is closed: that ordering
 * is what stops the superseded session's close from detaching the new entry
 * or clearing the connectivity the new session just set. registerSession and
 * detachSession own that identity rule for both completeAgentConnection3 and
 * obj.close; completeSession owns the supersede lifecycle, including the
 * connectivity re-affirm that made the reconnect fix necessary.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

// Take the entry over and return whichever session held it before.
function registerSession(wsagents, nodeKey, agent) {
    const superseded = wsagents[nodeKey];
    wsagents[nodeKey] = agent;
    return superseded;
}

// Detach a session only while it still owns the entry. A superseded session's
// later close returns false, so the caller leaves the new session and its
// connectivity alone.
function detachSession(wsagents, nodeKey, agent) {
    if (wsagents[nodeKey] !== agent) { return false; }
    delete wsagents[nodeKey];
    return true;
}

// Complete a session into the registry: replace the entry, hand any
// superseded session to the caller to close, then re-affirm connectivity from
// the new session. Setting connectivity is idempotent when already set.
function completeSession(wsagents, nodeKey, agent, callbacks) {
    const superseded = registerSession(wsagents, nodeKey, agent);
    if (superseded != null) { callbacks.onSuperseded(superseded); }
    callbacks.setConnectivity(agent);
    return superseded;
}

module.exports = {
    registerSession: registerSession,
    detachSession: detachSession,
    completeSession: completeSession
};
