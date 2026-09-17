'use strict';

/**
 * @description Command rights shared by the user command routing.
 *
 * Desktop View Only grants a remote session but not the ability to act on the
 * device, so the listed msg command types require the non-right
 * MESHRIGHT_REMOTEVIEWONLY. isDeniedByNonRights is the single non-right rule
 * the routing consults, admin exemption included, so the deny and the admin
 * allow cannot drift apart. This tightens Desktop View Only for existing
 * users: they lose these command types.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const MESHRIGHT_REMOTEVIEWONLY = 0x00000100; // 256
const MESHRIGHT_ADMIN = 0xFFFFFFFF;

const VIEW_ONLY_FORBIDDEN_COMMAND_TYPES = Object.freeze([
    'openUrl', 'getclip', 'setclip', 'pskill', 'userSessions', 'messagebox',
    'serviceStop', 'serviceStart', 'serviceRestart', 'deskBackground',
    'localapp', 'alertbox'
]);

// The non-right a msg command type requires, or null when it is not gated by
// Desktop View Only.
function requiredNonRightsForMsg(type) {
    return VIEW_ONLY_FORBIDDEN_COMMAND_TYPES.includes(type) ? MESHRIGHT_REMOTEVIEWONLY : null;
}

// Non-rights deny a user unless they hold the right, with admins exempt.
function isDeniedByNonRights(rights, requiredNonRights) {
    return (requiredNonRights != null) && (rights !== MESHRIGHT_ADMIN) && ((rights & requiredNonRights) !== 0);
}

module.exports = {
    MESHRIGHT_REMOTEVIEWONLY: MESHRIGHT_REMOTEVIEWONLY,
    MESHRIGHT_ADMIN: MESHRIGHT_ADMIN,
    VIEW_ONLY_FORBIDDEN_COMMAND_TYPES: VIEW_ONLY_FORBIDDEN_COMMAND_TYPES,
    requiredNonRightsForMsg: requiredNonRightsForMsg,
    isDeniedByNonRights: isDeniedByNonRights
};
