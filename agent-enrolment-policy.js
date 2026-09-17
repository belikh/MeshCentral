'use strict';

/**
 * @description Source-address policy for new agent enrolment.
 *
 * The agentAllowedIPNewAgents setting, server level and domain level, is
 * applied only when the node key of a connecting agent is not yet known.
 * Entries use the same semantics as the other allow lists: bare addresses,
 * CIDR ranges and file: indirection read by readIpListFromFile. The server
 * and domain lists compose with AND, and a configured value that is not an
 * array of non-empty strings denies the enrolment with a message, so a
 * malformed configuration can never allow silently.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const fs = require('fs');
const path = require('path');
const ipcheck = require('ipcheck');

/**
* Read a list of IP addresses from a file: entry. A value that is not a
* string starting with "file:" is returned unchanged; a file that cannot be
* read resolves to null, as for the existing allow lists.
*/
function readIpListFromFile(arg, datapath) {
    if ((typeof arg != 'string') || (!arg.startsWith('file:'))) { return arg; }
    var contents = null;
    try { contents = fs.readFileSync(path.join(datapath, arg.substring(5))).toString(); } catch (ex) { }
    if (contents == null) { return null; }
    return parseIpListFileContents(contents);
}

/**
* Parse IP list file contents: one entry per line, blank lines and # comments
* are ignored, inline # comments are trimmed, and entries without a dot or
* leading colon (or with an @) are skipped.
*/
function parseIpListFileContents(contents) {
    const lines = contents.split(/\r?\n/).join('\r').split('\r');
    const validLines = [];
    for (var i in lines) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        if (line.charAt(0) === '#') continue;
        const parts = line.split('#');
        const candidate = parts[0].trim();
        if (candidate.length > 0 && candidate.indexOf('@') === -1 && (candidate.indexOf('.') > -1 || candidate.charAt(0) === ':')) {
            validLines.push(candidate);
        }
    }
    return validLines;
}

/**
* True when a configured value is a list of non-empty strings that can be
* handed to resolveDomainsToIps. Anything else is left untouched so the
* predicate can deny it with a message.
*/
function isResolvableIpList(value) {
    if (Array.isArray(value) == false) { return false; }
    for (var i in value) {
        if ((typeof value[i] != 'string') || (value[i].length == 0)) { return false; }
    }
    return true;
}

/**
* Decide whether a new agent may enrol from the source address. Existing
* nodes are always allowed; otherwise the server list and the domain list
* must both be unset or match the address. A malformed list denies and
* reports through the optional log function.
*/
function isNewAgentAllowed(sourceIp, nodeExists, serverList, domainList, log) {
    if (nodeExists) { return true; }
    const serverAllowed = listAllows(sourceIp, serverList, 'agentAllowedIPNewAgents (server)', log);
    const domainAllowed = listAllows(sourceIp, domainList, 'agentAllowedIPNewAgents (domain)', log);
    return serverAllowed && domainAllowed;
}

/** True when the list is unset or contains an entry matching the address. */
function listAllows(sourceIp, list, label, log) {
    if (list == null) { return true; }
    if (Array.isArray(list) == false) {
        report(log, 'Invalid ' + label + ': expected an array of IP addresses, CIDR ranges or file: entries; denying new agent from ' + sourceIp + '.');
        return false;
    }
    for (var i = 0; i < list.length; i++) {
        if ((typeof list[i] != 'string') || (list[i].length == 0)) {
            report(log, 'Invalid ' + label + ' entry at index ' + i + ': expected a non-empty string; denying new agent from ' + sourceIp + '.');
            return false;
        }
    }
    for (var i = 0; i < list.length; i++) {
        try {
            if (ipcheck.match(sourceIp, list[i])) { return true; }
        } catch (ex) {
            report(log, 'Invalid ' + label + ' entry at index ' + i + ' (' + list[i] + '): ' + ex + '; denying new agent from ' + sourceIp + '.');
            return false;
        }
    }
    return false;
}

/** Send a message to the optional log function. */
function report(log, message) {
    if (typeof log == 'function') { log(message); }
}

module.exports = {
    readIpListFromFile: readIpListFromFile,
    parseIpListFileContents: parseIpListFileContents,
    isResolvableIpList: isResolvableIpList,
    isNewAgentAllowed: isNewAgentAllowed
};
