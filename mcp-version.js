'use strict';

/**
* @description Version surface for the MCP bridge.
*
* Two independent versions travel with the bridge: the bridge's own version
* (package.json, always the MeshCentral version) and the tool schema version,
* which is bumped whenever the MCP tool surface changes shape. `--version`
* prints both, and the MCP server advertises both through its initialization
* info, so a client can tell whether the tool schemas it holds are current.
*
* Requiring this module has no side effects.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const packageJson = require('./package.json');

// Bump when the tool names, arguments or result shapes change in a way a
// client should notice. Independent of the bridge version.
const TOOL_SCHEMA_VERSION = '1.0.0';

const BRIDGE_VERSION = packageJson.version;

module.exports = {
    BRIDGE_VERSION: BRIDGE_VERSION,
    TOOL_SCHEMA_VERSION: TOOL_SCHEMA_VERSION
};
