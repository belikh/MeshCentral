'use strict';

/**
 * @description Execution of a catalogue entry's protocol mapping.
 *
 * Both consumers of the command catalogue run their requests through this
 * module: the MCP tool handlers (mcp-tools.js) and the CLI dispatch
 * (cli-dispatch.js). Keeping one executor is what makes the two surfaces send
 * the same requests for a declared entry.
 *
 * The executor knows four ways to produce a command result:
 *   { action, params?(args) }         a single control request
 *   [ { action, ... }, ... ]          several requests, in order, responses
 *                                     returned as an ordered array
 *   { method, params?(args) }         a client method call
 *   { local: (args) => value }        a handler on this host, no client
 *   { from: 'serverInfo' }            a value captured during the handshake
 *
 * A request spec may declare:
 *   action: (args) => name    pick the action per call (power, sharing)
 *   matchAction: true         the server quotes no responseid; match by action
 *                             (a function of args selects it per call)
 *   byAction: true            the server response does not echo the responseid
 *                             and must be correlated on its action instead
 *                             (login tokens, reports)
 *   follow: (response, args) => spec[]    requests derived from a response,
 *                             such as one membership removal per user in a
 *                             user group; their responses append to the
 *                             ordered response array
 *   resultValue: true         the response's result field is the command's
 *                             value, not an error; the format must surface any
 *                             server rejection it can recognise
 *   optional: true            a request may fail without failing the command
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

/** True when a response carries a server result other than success. */
function isServerError(response) {
    return (response.result != null) && (response.result !== 'ok') && (response.result !== 'OK');
}

/**
* Execute the protocol mapping declared by a catalogue entry against a client.
* Resolves with the response (single request), the ordered response array
* (several requests) or the handshake value (from). Optional requests that
* fail resolve to null so commands can report partial data. Every other
* server error is thrown verbatim.
*/
async function executeProtocol(client, entry, args) {
    const protocol = entry.protocol;
    if (protocol == null) { throw new Error('The ' + entry.name + ' command has no protocol mapping.'); }

    if (!Array.isArray(protocol)) {
        if (protocol.local != null) { return protocol.local(args); }
        if (protocol.method != null) {
            const method = String(protocol.method);
            if (typeof client[method] !== 'function') {
                throw new Error('The MeshCentral client does not provide the ' + method + ' method required by the ' + entry.name + ' command.');
            }
            return client[method]((protocol.params != null) ? protocol.params(args) : {});
        }
        if (protocol.from != null) {
            const value = client[protocol.from];
            if (value == null) { throw new Error('No ' + protocol.from + ' is available from the connection handshake.'); }
            return value;
        }
    }

    const specs = Array.isArray(protocol) ? protocol : [protocol];
    const responses = [];
    const run = async (spec) => {
        const action = (typeof spec.action === 'function') ? spec.action(args) : spec.action;
        const params = (spec.params != null) ? spec.params(args) : {};
        const matchAction = (typeof spec.matchAction === 'function') ? (spec.matchAction(args) === true) : (spec.matchAction === true);
        let response = null;
        try {
            if (spec.byAction === true) {
                response = await client.requestByAction(action, params);
            } else {
                response = await client.request(action, params, matchAction ? { matchAction: true } : undefined);
            }
        } catch (error) {
            if (spec.optional) { responses.push(null); return; }
            throw error;
        }
        if (response == null) {
            if (spec.optional) { responses.push(null); return; }
            throw new Error('The MeshCentral server returned no response for the ' + action + ' action.');
        }
        if ((spec.resultValue !== true) && isServerError(response)) {
            if (spec.optional) { responses.push(null); return; }
            throw new Error(String(response.result));
        }
        responses.push(response);
        if (typeof spec.follow === 'function') {
            for (const followed of (spec.follow(response, args) || [])) { await run(followed); }
        }
    };
    for (const spec of specs) { await run(spec); }
    return Array.isArray(protocol) ? responses : responses[0];
}

module.exports = {
    executeProtocol: executeProtocol,
    isServerError: isServerError
};
