'use strict';

/**
 * @description Terminal context-menu restrictions.
 *
 * A domain may restrict which terminal shells can be launched with the
 * terminal.contextMenu setting (lowercased to contextmenu when the config file
 * is loaded). The value is a list of entries, each one of 'all', 'admin',
 * 'user' or 'ask':
 *
 *   all    every shell may be launched
 *   admin  admin/root shells: protocol 1 (terminal) and 6 (admin PowerShell)
 *   user   user shells: protocol 7 (switch to user shell), 8 (user shell)
 *          and 9 (user PowerShell)
 *   ask    permits the "ask" menu variants of the shells enabled by admin/user
 *
 * The web UI (webserver.js) and the relay (meshrelay.js) both resolve the
 * setting through getTerminalMenuMask(), so the menu and the server agree on
 * the allowed set. Entries are normalised with trim().toLowerCase() before
 * matching, so the two sides cannot drift on case or whitespace.
 *
 * An absent setting (undefined or null) keeps the documented default of
 * ['all']. A setting that is present but empty, malformed or made only of
 * unrecognised entries denies every shell protocol: the mask stays 0 and
 * there is no allow-all fallback.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const TERMINAL_MENU_ADMIN = 0x1; // Admin Shell (1) and Admin PowerShell (6)
const TERMINAL_MENU_USER = 0x2;  // Switch to user shell (7), User Shell (8) and User PowerShell (9)
const TERMINAL_MENU_ASK = 0x4;   // Ask menu variants of the shells enabled by admin/user
const TERMINAL_MENU_ALL = TERMINAL_MENU_ADMIN | TERMINAL_MENU_USER | TERMINAL_MENU_ASK;

// Shell protocol to menu class. Every other protocol is unrelated to the menu.
const TERMINAL_PROTOCOL_CLASS = { 1: 'admin', 6: 'admin', 7: 'user', 8: 'user', 9: 'user' };

/**
* Read the raw terminal.contextMenu setting from a domain. The config loader
* lowercases config keys, so the lowercased key is read first and the
* camelCase key is a fallback for domains built in code. Returns undefined
* when the setting is absent (undefined or null).
*/
function getTerminalContextMenuSetting(domain) {
    if ((domain == null) || (typeof domain.terminal != 'object') || (domain.terminal == null)) { return undefined; }
    let setting = domain.terminal.contextmenu;
    if (setting == null) { setting = domain.terminal.contextMenu; }
    return (setting == null) ? undefined : setting;
}

/**
* Resolve the terminal menu setting to its bit mask: TERMINAL_MENU_ADMIN for
* 'admin', TERMINAL_MENU_USER for 'user', TERMINAL_MENU_ASK for 'ask' and
* TERMINAL_MENU_ALL for 'all'. An absent setting defaults to all; a present
* but empty or unrecognised setting resolves to 0, which denies every shell.
*/
function getTerminalMenuMask(domain) {
    const setting = getTerminalContextMenuSetting(domain);
    if (setting === undefined) { return TERMINAL_MENU_ALL; } // Not configured, use the documented default.
    const entries = (typeof setting == 'string') ? [setting] : setting;
    if (Array.isArray(entries) == false) { return 0; } // Configured with something that is not a string or list: deny.
    let mask = 0;
    for (let i = 0; i < entries.length; i++) {
        if (typeof entries[i] != 'string') { continue; } // Ignore anything that is not a menu entry name.
        const entry = entries[i].trim().toLowerCase();
        if (entry == 'all') { return TERMINAL_MENU_ALL; }
        else if (entry == 'admin') { mask |= TERMINAL_MENU_ADMIN; }
        else if (entry == 'user') { mask |= TERMINAL_MENU_USER; }
        else if (entry == 'ask') { mask |= TERMINAL_MENU_ASK; }
    }
    return mask; // May be 0: an empty or unrecognised setting denies every shell.
}

/**
* Return 'admin' or 'user' for a shell protocol, or null for every protocol
* the terminal context menu does not govern.
*/
function getTerminalProtocolClass(protocol) {
    if ((typeof protocol != 'number') || (Number.isInteger(protocol) == false)) { return null; }
    return Object.prototype.hasOwnProperty.call(TERMINAL_PROTOCOL_CLASS, protocol) ? TERMINAL_PROTOCOL_CLASS[protocol] : null;
}

/**
* True when the relay may launch this protocol for this domain. Protocols
* outside the shell set are always allowed; a shell protocol is allowed only
* when its class bit is set in the menu mask.
*/
function isTerminalProtocolAllowed(domain, protocol) {
    const protocolClass = getTerminalProtocolClass(protocol);
    if (protocolClass == null) { return true; } // Not a shell protocol, the terminal menu does not apply.
    const bit = (protocolClass == 'admin') ? TERMINAL_MENU_ADMIN : TERMINAL_MENU_USER;
    return ((getTerminalMenuMask(domain) & bit) != 0);
}

module.exports = {
    TERMINAL_MENU_ALL,
    TERMINAL_MENU_ADMIN,
    TERMINAL_MENU_USER,
    TERMINAL_MENU_ASK,
    getTerminalMenuMask,
    getTerminalProtocolClass,
    isTerminalProtocolAllowed
};
