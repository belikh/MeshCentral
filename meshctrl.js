#!/usr/bin/env node

/**
* @description MeshCentral command line tool
* @author Ylian Saint-Hilaire
* @copyright Intel Corporation 2018-2022
* @license Apache-2.0
* @version v0.0.1
*/

// Make sure we have the dependency modules
try { require('minimist'); } catch (ex) { console.log('Missing module "minimist", type "npm install minimist" to install it.'); return; }
try { require('ws'); } catch (ex) { console.log('Missing module "ws", type "npm install ws" to install it.'); return; }

var settings = {};
var generatedCommand = false;
const crypto = require('crypto');
const args = require('minimist')(process.argv.slice(2));
const path = require('path');
const catalogue = require('./command-catalogue.js');
const cliDispatch = require('./cli-dispatch.js');
const possibleCommands = catalogue.commandNames();
const { redactCredentials } = require('./meshcentral-client');
if (args.proxy != null) { try { require('https-proxy-agent'); } catch (ex) { console.log('Missing module "https-proxy-agent", type "npm install https-proxy-agent" to install it.'); return; } }

if (args['_'].length == 0) {
    console.log("MeshCtrl performs command line actions on a MeshCentral server.");
    console.log("Information at: https://meshcentral.com");
    console.log("No action specified, use MeshCtrl like this:\r\n\r\n  meshctrl [action] [arguments]\r\n");
    console.log("Supported actions:");
    console.log("  Help [action]               - Get help on an action.");
    console.log("  ServerInfo                  - Show server information.");
    console.log("  ServerVersion               - Show server version.");
    console.log("  UserInfo                    - Show user information.");
    console.log("  ListUsers                   - List user accounts.");
    console.log("  ListUserSessions            - List online users.");
    console.log("  ListUserGroups              - List user groups.");
    console.log("  ListDevices                 - List devices.");
    console.log("  ListDeviceGroups            - List device groups.");
    console.log("  ListUsersOfDeviceGroup      - List the users in a device group.");
    console.log("  ListEvents                  - List server events.");
    console.log("  LoginTokens                 - List, create and remove login tokens.");
    console.log("  DeviceInfo                  - Show information about a device.");
    console.log("  AddLocalDevice              - Add a local device.");
    console.log("  AddAmtDevice                - Add a AMT device.");
    console.log("  EditDevice                  - Make changes to a device.");
    console.log("  RemoveDevice                - Delete a device.");
    console.log("  Config                      - Perform operation on config.json file.");
    console.log("  AddUser                     - Create a new user account.");
    console.log("  EditUser                    - Change a user account.");
    console.log("  RemoveUser                  - Delete a user account.");
    console.log("  AddUserGroup                - Create a new user group.");
    console.log("  RemoveUserGroup             - Delete a user group.");
    console.log("  AddToUserGroup              - Add a user, device or device group to a user group.");
    console.log("  RemoveFromUserGroup         - Remove a user, device or device group from a user group.");
    console.log("  RemoveAllUsersFromUserGroup - Remove all users from a user group.");
    console.log("  AddDeviceGroup              - Create a new device group.");
    console.log("  RemoveDeviceGroup           - Delete a device group.");
    console.log("  EditDeviceGroup             - Change a device group values.");
    console.log("  MoveToDeviceGroup           - Move a device to a different device group.");
    console.log("  AddUserToDeviceGroup        - Add a user to a device group.");
    console.log("  RemoveUserFromDeviceGroup   - Remove a user from a device group.");
    console.log("  AddUserToDevice             - Add a user to a device.");
    console.log("  RemoveUserFromDevice        - Remove a user from a device.");
    console.log("  SendInviteEmail             - Send an agent install invitation email.");
    console.log("  GenerateInviteLink          - Create an invitation link.");
    console.log("  Broadcast                   - Display a message to all online users.");
    console.log("  ShowEvents                  - Display real-time server events in JSON format.");
    console.log("  RunCommand                  - Run a shell command on a remote device.");
    console.log("  Shell                       - Access command shell of a remote device.");
    console.log("  Upload                      - Upload a file to a remote device.");
    console.log("  Download                    - Download a file from a remote device.");
    console.log("  WebRelay                    - Creates a HTTP/HTTPS webrelay link for a remote device.");
    console.log("  DeviceOpenUrl               - Open a URL on a remote device.");
    console.log("  DeviceMessage               - Open a message box on a remote device.");
    console.log("  DeviceToast                 - Display a toast notification on a remote device.");
    console.log("  GroupMessage                - Open a message box on remote devices in a specific device group.");
    console.log("  GroupToast                  - Display a toast notification on remote devices in a specific device group.");
    console.log("  DevicePower                 - Perform wake/sleep/reset/off operations on remote devices.");
    console.log("  DeviceSharing               - View, add and remove sharing links for a given device.");
    console.log("  AgentDownload               - Download an agent of a specific type for a device group.");
    console.log("  Report                      - Create and show a CSV report.");
    console.log("\r\nSupported login arguments:");
    console.log("  --url [wss://server]        - Server url, wss://localhost:443 is default.");
    console.log("                              - Use wss://localhost:443?key=xxx if login key is required.");
    console.log("  --loginuser [username]      - Login username, admin is default.");
    console.log("  --loginpass [password]      - Login password OR Leave blank to enter password at prompt");
    console.log("  --token [number]            - 2nd factor authentication token.");
    console.log("  --loginkey [hex]            - Server login key in hex.");
    console.log("  --loginkeyfile [file]       - File containing server login key in hex.");
    console.log("  --logindomain [domainid]    - Domain id, default is empty, only used with loginkey.");
    console.log("  --proxy [http://proxy:123]  - Specify an HTTP proxy.");
    return;
} else {
    settings.cmd = args['_'][0].toLowerCase();
    if ((possibleCommands.indexOf(settings.cmd) == -1) && (settings.cmd != 'help')) { console.log("Invalid command. Possible commands are: " + possibleCommands.join(', ') + '.'); return; }
    //console.log(settings.cmd);

    var ok = false;
    // Every command the catalogue can express is dispatched from its entry
    // (cli-dispatch.js): declared arguments, declared checks, the shared
    // protocol mapping and the CLI formatting. Only the enumerated exceptions
    // below keep a hand-written validation and request path.
    var catalogueEntry = catalogue.byName(settings.cmd);
    generatedCommand = cliDispatch.isGenerated(catalogueEntry);
    if (generatedCommand) {
        if (cliDispatch.isLocal(catalogueEntry)) {
            cliDispatch.runLocal(catalogueEntry, args).then(function () { }, function (error) {
                console.log(redactCredentials((error != null) && (error.message != null) ? error.message : String(error)));
                process.exit(1);
            });
            return;
        }
        var problem = cliDispatch.validationMessage(catalogueEntry, cliDispatch.buildArguments(catalogueEntry, args));
        if (problem != null) { console.log(problem); return; }
        ok = true;
    }
    switch (settings.cmd) {
        case 'config': { performConfigOperations(args); return; }
        case 'listdevices': { ok = true; break; }
        case 'showevents': { ok = true; break; }
        case 'editdevice': {
            if (args.id == null) { console.log(winRemoveSingleQuotes("Missing device id, use --id '[deviceid]'")); }
            else { ok = true; }
            break;
        }
        case 'shell': {
            if (args.id == null) { console.log(winRemoveSingleQuotes("Missing device id, use --id '[deviceid]'")); }
            else { ok = true; }
            break;
        }
        case 'upload': {
            if (args.id == null) { console.log(winRemoveSingleQuotes("Missing device id, use --id '[deviceid]'")); }
            else if (args.file == null) { console.log("Local file missing, use --file [file] specify the file to upload"); }
            else if (args.target == null) { console.log("Remote target path missing, use --target [path] to specify the remote location"); }
            else if (require('fs').existsSync(args.file) == false) { console.log("Local file does not exists, check --file"); }
            else { ok = true; }
            break;
        }
        case 'download': {
            if (args.id == null) { console.log(winRemoveSingleQuotes("Missing device id, use --id '[deviceid]'")); }
            else if (args.file == null) { console.log("Remote file missing, use --file [file] specify the remote file to download"); }
            else if (args.target == null) { console.log("Target path missing, use --target [path] to specify the local download location"); }
            else { ok = true; }
            break;
        }
        case 'help': {
            if (args['_'].length < 2) {
                console.log("Get help on an action. Type:\r\n\r\n  help [action]\r\n\r\nPossible actions are: " + possibleCommands.join(', ') + '.');
            } else {
                switch (args['_'][1].toLowerCase()) {
                    case 'config': {
                        displayConfigHelp();
                        break;
                    }
                    case 'sendinviteemail': {
                        console.log("Send invitation email with instructions on how to install the mesh agent for a specific device group. Example usage:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl SendInviteEmail --id 'groupid' --message \"msg\" --email user@sample.com"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl SendInviteEmail --group \"My Computers\" --name \"Jack\" --email user@sample.com"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Device group name (or --id).");
                        console.log("  --email [email]        - Email address.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --name (name)          - Name of recipient to be included in the email.");
                        console.log("  --message (msg)        - Message to be included in the email.");
                        break;
                    }
                    case 'generateinvitelink': {
                        console.log("Generate a agent invitation URL for a given group. Example usage:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl GenerateInviteLink --id 'groupid' --hours 24"));
                        console.log("  MeshCtrl GenerateInviteLink --group \"My Computers\" --hours 0");
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Device group name (or --id).");
                        console.log("  --hours [hours]        - Validity period in hours or 0 for infinite.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --flags [mode]         - Mode flag for link type (0 = both, 1 = interactive only, 2 = background only)");
                        break;
                    }
                    case 'showevents': {
                        console.log("Show the server's event stream for this user account. Example usage:\r\n");
                        console.log("  MeshCtrl ShowEvents");
                        console.log("  MeshCtrl ShowEvents --filter nodeconnect");
                        console.log("  MeshCtrl ShowEvents --filter uicustomevent,changenode");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --filter [actions]    - Show only specified actions.");
                        break;
                    }
                    case 'serverinfo': {
                        console.log("Get information on the MeshCentral server, Example usages:\r\n");
                        console.log("  MeshCtrl ServerInfo --loginuser myaccountname --loginpass mypassword");
                        console.log("  MeshCtrl ServerInfo --loginuser myaccountname --loginkeyfile key.txt");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --json                 - Show result as JSON.");
                        break;
                    }
                    case 'serverversion': {
                        console.log("Get the version of the MeshCentral server, Example usages:\r\n");
                        console.log("  MeshCtrl ServerVersion --loginuser myaccountname --loginpass mypassword");
                        console.log("  MeshCtrl ServerVersion --loginuser myaccountname --loginkeyfile key.txt");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --json                 - Show result as JSON.");
                        break;
                    }
                    case 'userinfo': {
                        console.log("Get account information for the login account, Example usages:\r\n");
                        console.log("  MeshCtrl UserInfo --loginuser myaccountname --loginpass mypassword");
                        console.log("  MeshCtrl UserInfo --loginuser myaccountname --loginkeyfile key.txt");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --json                 - Show result as JSON.");
                        break;
                    }
                    case 'listusers': {
                        console.log("List the account on the MeshCentral server, Example usages:\r\n");
                        console.log("  MeshCtrl ListUsers");
                        console.log("  MeshCtrl ListUsers --json");
                        console.log("  MeshCtrl ListUsers --nameexists \"bob\"");
                        console.log("  MeshCtrl ListUsers --filter 2fa");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --idexists [id]        - Return 1 if id exists, 0 if not.");
                        console.log("  --nameexists [name]    - Return id if name exists.");
                        console.log("  --filter [filter1,...] - Filter user names: 2FA, NO2FA.");
                        console.log("  --json                 - Show result as JSON.");
                        break;
                    }
                    case 'listusersessions': {
                        console.log("List active user sessions on the MeshCentral server, Example usages:\r\n");
                        console.log("  MeshCtrl ListUserSessions");
                        console.log("  MeshCtrl ListUserSessions --json");
                        break;
                    }
                    case 'listusergroups': {
                        console.log("List user groups on the MeshCentral server, Example usages:\r\n");
                        console.log("  MeshCtrl ListUserGroups");
                        console.log("  MeshCtrl ListUserGroups --json");
                        break;
                    }
                    case 'listdevicegroups': {
                        console.log("List the device groups for this account. Example usages:\r\n");
                        console.log("  MeshCtrl ListDeviceGroups ");
                        console.log("  MeshCtrl ListDeviceGroups --json");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --idexists [id]        - Return 1 if id exists, 0 if not.");
                        console.log("  --nameexists [name]    - Return id if name exists.");
                        console.log("  --emailexists [email]  - Return id if email exists.");
                        console.log("  --hex                  - Display meshid in hex format.");
                        console.log("  --json                 - Show result as JSON.");
                        break;
                    }
                    case 'listdevices': {
                        console.log("List devices. Example usages:\r\n");
                        console.log("  MeshCtrl ListDevices");
                        console.log(winRemoveSingleQuotes("  MeshCtrl ListDevices -id '[groupid]' --json"));
                        console.log("\r\nOptional arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Filter by group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Filter by group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Filter by group name (or --id).");
                        console.log("  --count                - Only return the device count.");
                        console.log("  --json                 - Show result as JSON.");
                        console.log("  --csv                  - Show result as comma separated values.");
                        console.log("  --filter \"[filter]\"  - Filter devices using a filter string.");
                        console.log("     \"x\"                  - Devices with \"x\" in the name.");
                        console.log("     \"user:x or u:x\"      - Devices with \"x\" in the name of currently logged in user.");
                        console.log("     \"ip:x\"               - Devices \"x\" IP address.");
                        console.log("     \"group:x or g:x\"     - Devices with \"x\" in device group name.");
                        console.log("     \"tag:x or t:x\"       - Devices with \"x\" in device tag.");
                        console.log("     \"atag:x or a:x\"      - Devices with \"x\" in device agent tag.");
                        console.log("     \"os:x\"               - Devices with \"x\" in the device OS description.");
                        console.log("     \"amt:x\"              - Devices with Intel AMT provisioning state (0, 1, 2).");
                        console.log("     \"desc:x\"             - Devices with \"x\" in device description.");
                        console.log("     \"wsc:ok\"             - Devices with Windows Security Center ok.");
                        console.log("     \"wsc:noav\"           - Devices with Windows Security Center with anti-virus problem.");
                        console.log("     \"wsc:noupdate\"       - Devices with Windows Security Center with update problem.");
                        console.log("     \"wsc:nofirewall\"     - Devices with Windows Security Center with firewall problem.");
                        console.log("     \"wsc:any\"            - Devices with Windows Security Center with any problem.");
                        console.log("     \"a and b\"            - Match both conditions with precedence over OR. For example: \"lab and g:home\".");
                        console.log("     \"a or b\"             - Math one of the conditions, for example: \"lab or g:home\".");
                        console.log("  --filterid [id,id...]  - Show only results for devices with included id.");
                        console.log("  --details              - Show all device details.");
                        break;
                    }
                    case 'listusersofdevicegroup': {
                        console.log("List users that have permissions for a given device group. Example usage:\r\n");
                        console.log("  MeshCtrl ListUserOfDeviceGroup ");
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier.");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --json                 - Show result as JSON.");
                        break;
                    }
                    case 'listevents': {
                        console.log("List server events optionally filtered by user or device. Example usage:\r\n");
                        console.log("  MeshCtrl ListEvents ");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --userid [name]        - User account identifier.");
                        console.log("  --id [deviceid]        - The device identifier.");
                        console.log("  --limit [number]       - Maximum number of events to list.");
                        console.log("  --raw                  - Output raw data in JSON format.");
                        console.log("  --json                 - Give results in JSON format.");
                        break;
                    }
                    case 'logintokens': {
                        console.log("List account login tokens and allow addition and removal. Example usage:\r\n");
                        console.log("  MeshCtrl LoginTokens ");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --remove [name]        - Remove a login token.");
                        console.log("  --add [name]           - Add a login token.");
                        console.log("  --expire [minutes]     - When adding a token, minutes until expire.");
                        console.log("  --json                 - Show login tokens in JSON format.");
                        break;
                    }
                    case 'adduser': {
                        console.log("Add a new user account. Example usages:\r\n");
                        console.log("  MeshCtrl AddUser --user newaccountname --pass newpassword");
                        console.log("  MeshCtrl AddUser --user newaccountname --randompass --rights full");
                        console.log("\r\nRequired arguments:\r\n");
                        console.log("  --user [name]               - New account name.");
                        console.log("  --pass [password]           - New account password.");
                        console.log("  --randompass                - Create account with a random password.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --domain [domain]           - Account domain, only for cross-domain admins.");
                        console.log("  --email [email]             - New account email address.");
                        console.log("  --emailverified             - New account email is verified.");
                        console.log("  --resetpass                 - Request password reset on next login.");
                        console.log("  --realname [name]           - Set the real name for this account.");
                        console.log("  --phone [number]            - Set the account phone number.");
                        console.log("  --rights [none|full|a,b,c]  - Comma separated list of server permissions. Possible values:");
                        console.log("     manageusers,serverbackup,serverrestore,serverupdate,fileaccess,locked,nonewgroups,notools,usergroups,recordings,locksettings,allevents,nonewdevices");
                        break;
                    }
                    case 'edituser': {
                        console.log("Edit a user account, Example usages:\r\n");
                        console.log("  MeshCtrl EditUser --userid user --rights locked,locksettings");
                        console.log("  MeshCtrl EditUser --userid user --realname Jones");
                        console.log("\r\nRequired arguments:\r\n");
                        console.log("  --userid [name]             - User account identifier.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --domain [domain]           - Account domain, only for cross-domain admins.");
                        console.log("  --email [email]             - Account email address.");
                        console.log("  --emailverified             - Account email is verified.");
                        console.log("  --resetpass                 - Request password reset on next login.");
                        console.log("  --realname [name]           - Set the real name for this account.");
                        console.log("  --phone [number]            - Set the account phone number.");
                        console.log("  --rights [none|full|a,b,c]  - Comma separated list of server permissions. Possible values:");
                        console.log("     manageusers,serverbackup,serverrestore,serverupdate,fileaccess,locked,nonewgroups,notools,usergroups,recordings,locksettings,allevents,nonewdevices");
                        break;
                    }
                    case 'removeuser': {
                        console.log("Delete a user account, Example usages:\r\n");
                        console.log("  MeshCtrl RemoveUser --userid accountid");
                        console.log("\r\nRequired arguments:\r\n");
                        console.log("  --userid [id]          - Account identifier.");
                        break;
                    }
                    case 'addusergroup': {
                        console.log("Create a new user group, Example usages:\r\n");
                        console.log("  MeshCtrl AddUserGroup --name \"Test Group\"");
                        console.log("\r\nRequired arguments:\r\n");
                        console.log("  --name [name]          - Name of the user group.");
                        break;
                    }
                    case 'removeusergroup': {
                        console.log("Remove a user group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveUserGroup --groupid 'ugrp//abcdf'"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --groupid [groupid]   - User group identifier.");
                        } else {
                            console.log("  --groupid '[groupid]' - User group identifier.");
                        }
                        break;
                    }
                    case 'addtousergroup': {
                        console.log("Add a user, device or device group to a user group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddToUserGroup --id 'user//abcdef' --groupid 'ugrp//abcdf'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddToUserGroup --id 'node//abcdef' --groupid 'ugrp//abcdf' --rights [rights]"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddToUserGroup --id 'mesh//abcdef' --groupid 'ugrp//abcdf' --rights [rights]"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [id]             - Identifier to add.");
                            console.log("  --groupid [groupid]   - User group identifier.");
                        } else {
                            console.log("  --id '[id]'           - Identifier to add.");
                            console.log("  --groupid '[groupid]' - User group identifier.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --rights [number]     - Rights granted for adding device or device group.");
                        console.log("                        - 4294967295 for full admin or the sum of the following numbers.");
                        console.log("          1 = Edit Device Group                2 = Manage Users           ");
                        console.log("          4 = Manage Computers                 8 = Remote Control         ");
                        console.log("         16 = Agent Console                   32 = Server Files           ");
                        console.log("         64 = Wake Device                    128 = Set Notes              ");
                        console.log("        256 = Remote View Only               512 = No Terminal            ");
                        console.log("       1024 = No Files                      2048 = No Intel AMT           ");
                        console.log("       4096 = Desktop Limited Input         8192 = Limit Events           ");
                        console.log("      16384 = Chat / Notify                32768 = Uninstall Agent        ");
                        console.log("      65536 = No Remote Desktop           131072 = Remote Commands        ");
                        console.log("     262144 = Reset / Power off          4194304 = No Registry            ");
                        console.log("    8388608 = No Software                                                 ");
                        break;
                    }
                    case 'removefromusergroup': {
                        console.log("Remove a user, device or device group from a user group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveUserFromUserGroup --userid 'user//abcdef' --groupid 'ugrp//abcdf'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveUserFromUserGroup --userid 'node//abcdef' --groupid 'ugrp//abcdf'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveUserFromUserGroup --userid 'mesh//abcdef' --groupid 'ugrp//abcdf'"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [userid]         - Identifier to remove.");
                            console.log("  --groupid [groupid]   - User group identifier.");
                        } else {
                            console.log("  --id '[userid]'       - Identifier to remove.");
                            console.log("  --groupid '[groupid]' - User group identifier.");
                        }
                        break;
                    }
                    case 'removeallusersfromusergroup': {
                        console.log("Remove all users from a user group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveAllUsersFromUserGroup --groupid 'ugrp//abcdf'"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --groupid [groupid]   - User group identifier.");
                        } else {
                            console.log("  --groupid '[groupid]' - User group identifier.");
                        }
                        break;
                    }
                    case 'adddevicegroup': {
                        console.log("Add a device group, Example usages:\r\n");
                        console.log("  MeshCtrl AddDeviceGroup --name newgroupname");
                        console.log("  MeshCtrl AddDeviceGroup --name newgroupname --desc description --amtonly");
                        console.log("  MeshCtrl AddDeviceGroup --name newgroupname --features 1 --consent 7");
                        console.log("\r\nRequired arguments:\r\n");
                        console.log("  --name [name]          - Name of the new group.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --desc [description]   - New group description.");
                        console.log("  --amtonly              - New group is agent-less, Intel AMT only.");
                        console.log("  --agentless            - New group is agent-less only.");
                        console.log("  --features [number]    - Set device group features, sum of numbers below.");
                        console.log("     1 = Auto-Remove                 2 = Hostname Sync");
                        console.log("     4 = Record Sessions");
                        console.log("  --consent [number]     - Set device group user consent, sum of numbers below.");
                        console.log("     1 = Desktop notify user         2 = Terminal notify user   ");
                        console.log("     4 = Files notify user           8 = Desktop prompt user    ");
                        console.log("    16 = Terminal prompt user       32 = Files prompt user      ");
                        console.log("    64 = Desktop Toolbar        ");
                        break;
                    }
                    case 'removedevicegroup': {
                        console.log("Remove a device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveDeviceGroup --id 'groupid'"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Device group name (or --id).");
                        break;
                    }
                    case 'editdevicegroup': {
                        console.log("Edit a device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl EditDeviceGroup --id 'groupid' --name \"New Name\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl EditDeviceGroup --id 'groupid' --desc \"Description\" --consent 63"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl EditDeviceGroup --id 'groupid' --invitecodes \"code1,code2\" --backgroundonly"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Device group name (or --id).");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --name [name]          - Set new device group name.");
                        console.log("  --desc [description]   - Set new device group description, blank to clear.");
                        console.log("  --flags [number]       - Set device group flags, sum of the values below, 0 for none.");
                        console.log("     1 = Auto remove device on disconnect.");
                        console.log("     2 = Sync hostname.");
                        console.log("  --consent [number]     - Set device group consent options, sum of the values below, 0 for none.");
                        console.log("     1 = Desktop notify user.");
                        console.log("     2 = Terminal notify user.");
                        console.log("     4 = Files notify user.");
                        console.log("     8 = Desktop prompt for user consent.");
                        console.log("    16 = Terminal prompt for user consent.");
                        console.log("    32 = Files prompt for user consent.");
                        console.log("    64 = Desktop show connection toolbar.");
                        console.log("  --invitecodes [aa,bb]  - Comma separated list of invite codes, blank to clear.");
                        console.log("    --backgroundonly     - When used with invitecodes, set agent to only install in background.");
                        console.log("    --interactiveonly    - When used with invitecodes, set agent to only run on demand.");
                        break;
                    }
                    case 'movetodevicegroup': {
                        console.log("Move a device to a new device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl MoveToDeviceGroup --devid 'deviceid' --id 'groupid'"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Device group name (or --id).");
                        if (process.platform == 'win32') {
                            console.log("  --devid [deviceid]     - Device identifier.");
                        } else {
                            console.log("  --devid '[deviceid]'   - Device identifier.");
                        }
                        break;
                    }
                    case 'addusertodevicegroup': {
                        console.log("Add a user to a device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddUserToDeviceGroup --id 'groupid' --userid userid --fullrights"));
                        console.log("  MeshCtrl AddUserToDeviceGroup --group groupname --userid userid --editgroup --manageusers");
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Device group name (or --id).");
                        console.log("  --userid [userid]      - The user identifier.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --fullrights           - Allow full rights over this device group.");
                        console.log("  --editgroup            - Allow the user to edit group information.");
                        console.log("  --manageusers          - Allow the user to add/remove users.");
                        console.log("  --managedevices        - Allow the user to edit device information.");
                        console.log("  --remotecontrol        - Allow device remote control operations.");
                        console.log("  --agentconsole         - Allow agent console operations.");
                        console.log("  --serverfiles          - Allow access to group server files.");
                        console.log("  --wakedevices          - Allow device wake operation.");
                        console.log("  --notes                - Allow editing of device notes.");
                        console.log("  --desktopviewonly      - Restrict user to view-only remote desktop.");
                        console.log("  --limiteddesktop       - Limit remote desktop keys.");
                        console.log("  --noterminal           - Hide the terminal tab from this user.");
                        console.log("  --nofiles              - Hide the files tab from this user.");
                        console.log("  --noregistry           - Hide the registry tab from this user.");
                        console.log("  --nosoftware           - Hide the software tab from this user.");
                        console.log("  --noamt                - Hide the Intel AMT tab from this user.");
                        console.log("  --limitedevents        - User can only see his own events.");
                        console.log("  --chatnotify           - Allow chat and notification options.");
                        console.log("  --uninstall            - Allow remote uninstall of the agent.");
                        if (args.limiteddesktop) { meshrights |= 4096; }
                        if (args.limitedevents) { meshrights |= 8192; }
                        if (args.chatnotify) { meshrights |= 16384; }
                        if (args.uninstall) { meshrights |= 32768; }

                        break;
                    }
                    case 'removeuserfromdevicegroup': {
                        console.log("Remove a user from a device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveuserFromDeviceGroup --id 'groupid' --userid userid"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]         - Device group identifier (or --group).");
                        } else {
                            console.log("  --id '[groupid]'       - Device group identifier (or --group).");
                        }
                        console.log("  --group [groupname]    - Device group name (or --id).");
                        console.log("  --userid [userid]      - The user identifier.");
                        break;
                    }
                    case 'addusertodevice': {
                        console.log("Add a user to a device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddUserToDevice --id 'deviceid' --userid userid --fullrights"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddUserToDevice --id 'deviceid' --userid userid --remotecontrol"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("  --userid [userid]      - The user identifier.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --fullrights           - Allow full rights over this device.");
                        console.log("  --remotecontrol        - Allow device remote control operations.");
                        console.log("  --agentconsole         - Allow agent console operations.");
                        console.log("  --serverfiles          - Allow access to group server files.");
                        console.log("  --wakedevices          - Allow device wake operation.");
                        console.log("  --notes                - Allow editing of device notes.");
                        console.log("  --desktopviewonly      - Restrict user to view-only remote desktop.");
                        console.log("  --limiteddesktop       - Limit remote desktop keys.");
                        console.log("  --noterminal           - Hide the terminal tab from this user.");
                        console.log("  --nofiles              - Hide the files tab from this user.");
                        console.log("  --noregistry           - Hide the registry tab from this user.");
                        console.log("  --nosoftware           - Hide the software tab from this user.");
                        console.log("  --noamt                - Hide the Intel AMT tab from this user.");
                        console.log("  --limitedevents        - User can only see his own events.");
                        console.log("  --chatnotify           - Allow chat and notification options.");
                        console.log("  --uninstall            - Allow remote uninstall of the agent.");
                        break;
                    }
                    case 'removeuserfromdevice': {
                        console.log("Remove a user from a device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveuserFromDeviceGroup --id 'deviceid' --userid userid"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("  --userid [userid]      - The user identifier.");
                        break;
                    }
                    case 'broadcast': {
                        console.log("Display a message to one or all logged in users, Example usages:\r\n");
                        console.log("  MeshCtrl Broadcast --msg \"This is a test\"");
                        console.log("\r\nRequired arguments:\r\n");
                        console.log("  --msg [message]        - Message to display.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --user [userid]        - Send the message to the specified user.");
                        break;
                    }
                    case 'deviceinfo': {
                        console.log("Display information about a device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceInfo --id 'deviceid'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceInfo --id 'deviceid' --json"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --raw                  - Output raw data in JSON format.");
                        console.log("  --json                 - Give results in JSON format.");
                        break;
                    }
                    case 'removedevice': {
                        console.log("Delete a device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RemoveDevice --id 'deviceid'"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        break;
                    }
                    case 'addlocaldevice': {
                        console.log("Add a Local Device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddLocalDevice --id 'meshid' --devicename 'devicename' --hostname 'hostname'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddLocalDevice --id 'meshid' --devicename 'devicename' --hostname 'hostname' --type 6"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [meshid]                - The mesh identifier.");
                            console.log("  --devicename [devicename]    - The device name.");
                            console.log("  --hostname [hostname]        - The devices hostname or ip address.");
                        } else {
                            console.log("  --id '[meshid]'              - The mesh identifier.");
                            console.log("  --devicename '[devicename]'  - The device name.");
                            console.log("  --hostname '[hostname]'      - The devices hostname or ip address.");
                        }

                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --type [TypeNumber] - With the following choices:");
                        console.log("    type 4            - Default, Windows (RDP)");
                        console.log("    type 6            - Linux (SSH/SCP/VNC)");
                        console.log("    type 29           - macOS (SSH/SCP/VNC)");
                        break;
                    }
                    case 'addamtdevice': {
                        console.log("Add an Intel AMT Device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddAmtDevice --id 'meshid' --devicename 'devicename' --hostname 'hostname --user 'admin' --pass 'admin'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl AddAmtDevice --id 'meshid' --devicename 'devicename' --hostname 'hostname --user 'admin' --pass 'admin' --notls"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [meshid]                - The mesh identifier.");
                            console.log("  --devicename [devicename]    - The device name.");
                            console.log("  --hostname [hostname]        - The devices hostname or ip address.");
                            console.log("  --user [user]                - The devices AMT username.");
                            console.log("  --pass [pass]                - The devices AMT password.");
                            console.log("")
                        } else {
                            console.log("  --id '[meshid]'              - The mesh identifier.");
                            console.log("  --devicename '[devicename]'  - The device name.");
                            console.log("  --hostname '[hostname]'      - The devices hostname or ip address.");
                            console.log("  --user '[user]'              - The devices AMT username.");
                            console.log("  --pass '[pass]'              - The devices AMT password.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --notls                      - Use No TLS Security.");
                        } else {
                            console.log("  --notls                      - Use No TLS Security.");
                        }
                        break;
                    }
                    case 'editdevice': {
                        console.log("Change information about a device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl EditDevice --id 'deviceid' --name 'device1'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl EditDevice --id 'deviceid' --addtag 'newtag'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl EditDevice --id 'deviceid' --removetag 'oldtag'"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --name [name]           - Change device name.");
                            console.log("  --desc [description]    - Change device description.");
                            console.log("  --tags [tag1,tag2]      - Set device tags (replaces all existing tags).");
                            console.log("  --addtag [tag1,tag2]    - Add tags to existing tags.");
                            console.log("  --removetag [tag1,tag2] - Remove tags from existing tags.");
                        } else {
                            console.log("  --name '[name]'           - Change device name.");
                            console.log("  --desc '[description]'    - Change device description.");
                            console.log("  --tags '[tag1,tag2]'      - Set device tags (replaces all existing tags).");
                            console.log("  --addtag '[tag1,tag2]'    - Add tags to existing tags.");
                            console.log("  --removetag '[tag1,tag2]' - Remove tags from existing tags.");
                        }
                        console.log("  --icon [number]        - Change the device icon (1 to 8).");
                        console.log("  --consent [flags]      - Sum of the following numbers:");
                        console.log("      1 = Desktop notify          2 = Terminal notify");
                        console.log("      4 = Files notify            8 = Desktop prompt");
                        console.log("     16 = Terminal prompt        32 = Files prompt");
                        console.log("     64 = Desktop privacy bar");
                        break;
                    }
                    case 'runcommand': {
                        console.log("Run a shell command on a remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl RunCommand --id 'deviceid' --run \"command\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl RunCommand --id 'deviceid' --run \"command\" --powershell"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl RunCommand --id 'deviceid' --run \"command\" --reply"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("  --run \"[command]\"    - Shell command to execute on the remote device.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --powershell           - Run in Windows PowerShell.");
                        console.log("  --runasuser            - Attempt to run the command as logged in user.");
                        console.log("  --runasuseronly        - Only run the command as the logged in user.");
                        console.log("  --reply                - Return with the output from running the command.");
                        break;
                    }
                    case 'shell': {
                        console.log("Access a command shell on a remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl Shell --id 'deviceid'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl Shell --id 'deviceid' --powershell"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --powershell           - Run a Windows PowerShell.");
                        break;
                    }
                    case 'devicepower': {
                        console.log("Perform power operations on remote devices, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl DevicePower --wake --id 'deviceid'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DevicePower --sleep --id 'deviceid'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DevicePower --reset --id 'deviceid'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DevicePower --off --id 'deviceid1,deviceid2'"));
                        console.log("\r\nNote that some power operations may take up to a minute to execute.\r\n");
                        console.log("Required arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid1,deviceid2]    - Device identifiers.");
                        } else {
                            console.log("  --id '[deviceid1,deviceid2]'  - Device identifiers.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --wake                        - Attempt to wake up the remote device.");
                        console.log("  --reset                       - Attempt to remote the remote device.");
                        console.log("  --sleep                       - Attempt to place the remote device in low power mode.");
                        console.log("  --off                         - Attempt to power off the remote device.");
                        console.log("  --amtoff                      - Attempt to power off the remote device using Intel AMT.");
                        console.log("  --amton                       - Attempt to power on the remote device using Intel AMT.");
                        console.log("  --amtreset                    - Attempt to reset the remote device using Intel AMT.");
                        break;
                    }
                    case 'devicesharing': {
                        var tzoffset = (new Date()).getTimezoneOffset() * 60000; // Offset in milliseconds
                        var localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, -5);
                        console.log("List sharing links for a specified device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceSharing --id 'deviceid'"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceSharing --id 'deviceid' --remove abcdef"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceSharing --id 'deviceid' --add Guest --start " + localISOTime + " --duration 30"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceSharing --id 'deviceid' --add Guest --start " + localISOTime + " --duration 30 --daily"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceSharing --id 'deviceid' --add Guest --type desktop,terminal --consent prompt"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceSharing --id 'deviceid' --add Guest --type http --port 80"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]                - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'              - The device identifier.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --remove [shareid]                         - Remove a device sharing link.");
                        console.log("  --add [guestname]                          - Add a device sharing link.");
                        console.log("  --type [desktop,terminal,files,http,https] - Type of sharing to add, can be combined. default is desktop.");
                        console.log("  --viewonly                                 - Make desktop sharing view only.");
                        console.log("  --consent [notify,prompt,none]             - Consent flags, default is notify.");
                        console.log("  --start [yyyy-mm-ddThh:mm:ss]              - Start time, default is now.");
                        console.log("  --end [yyyy-mm-ddThh:mm:ss]                - End time.");
                        console.log("  --duration [minutes]                       - Duration of the share, default is 60 minutes.");
                        console.log("  --daily                                    - Add recurring daily device share.");
                        console.log("  --weekly                                   - Add recurring weekly device share.");
                        console.log("  --port [portnumber]                        - Set alternative port for http or https, default is 80 for http and 443 for https.");
                        break;
                    }
                    case 'agentdownload': {
                        console.log("Download an agent of a specific type for a given device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl AgentDownload --id 'groupid' --type 3"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl AgentDownload --id 'groupid' --type 3 --installflags 1"));
                        console.log("\r\nRequired arguments:\r\n");
                        console.log("  --type [ArchitectureNumber]   - Agent architecture number.");
                        if (process.platform == 'win32') {
                            console.log("  --id [groupid]                - The device group identifier.");
                        } else {
                            console.log("  --id '[groupid]'              - The device group identifier.");
                        }
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --installflags [InstallFlagsNumber] - With the following choices:");
                        console.log("    installflags 0                    - Default, Interactive & Background, offers connect button & install/uninstall");
                        console.log("    installflags 1                    - Interactive only, offers only connect button, not install/uninstall");
                        console.log("    installflags 2                    - Background only, offers only install/uninstall, not connect");
                        break;
                    }
                    case 'upload': {
                        console.log("Upload a local file to a remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl Upload --id 'deviceid' --file sample.txt --target c:\\"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl Upload --id 'deviceid' --file sample.txt --target /tmp"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("  --file [localfile]     - The local file to upload.");
                        console.log("  --target [remotepath]  - The remote path to upload the file to.");
                        break;
                    }
                    case 'download': {
                        console.log("Download a file from a remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl Download --id 'deviceid' --file C:\\sample.txt --target c:\\temp"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl Download --id 'deviceid' --file /tmp/sample.txt --target /tmp"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("  --file [remotefile]    - The remote file to download.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --target [localpath]   - The local path to download the file to.");
                        break;
                    }
                    case 'webrelay': {
                        console.log("Generate a webrelay URL to access a HTTP/HTTPS service on a remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl WebRelay --id 'deviceid' --type http --port 80"));
                        console.log(winRemoveSingleQuotes("  MeshCtrl WebRelay --id 'deviceid' --type https --port 443"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]     - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'     - The device identifier.");
                        }
                        console.log("  --type [http,https]   - Type of relay from remote device, http or https.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --port [portnumber]   - Set alternative port for http or https, default is 80 for http and 443 for https.");
                        break;
                    }
                    case 'deviceopenurl': {
                        console.log("Open a web page on a remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceOpenUrl --id 'deviceid' --openurl http://meshcentral.com"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("  --openurl [url]        - Link to the web page.");
                        break;
                    }
                    case 'devicemessage': {
                        console.log("Display a message on the remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceMessage --id 'deviceid' --msg \"message\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceMessage --id 'deviceid' --msg \"message\" --title \"title\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceMessage --id 'deviceid' --msg \"message\" --title \"title\" --timeout 120000"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]          - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'        - The device identifier.");
                        }
                        console.log("  --msg [message]          - The message to display.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --title [title]          - Messagebox title, default is \"MeshCentral\".");
                        console.log("  --timeout [miliseconds]  - After timeout messagebox vanishes, 0 keeps messagebox open until closed manually, default is 120000 (2 Minutes).");
                        break;
                    }
                    case 'devicetoast': {
                        console.log("Display a toast message on the remote device, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceToast --id 'deviceid' --msg \"message\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl DeviceToast --id 'deviceid' --msg \"message\" --title \"title\""));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [deviceid]        - The device identifier.");
                        } else {
                            console.log("  --id '[deviceid]'      - The device identifier.");
                        }
                        console.log("  --msg [message]        - The message to display.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --title [title]        - Toast title, default is \"MeshCentral\".");
                        break;
                    }
                    case 'groupmessage': {
                        console.log("Open a message box on remote devices in a specific device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl GroupMessage --id 'devicegroupid' --msg \"message\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl GroupMessage --id 'devicegroupid' --msg \"message\" --title \"title\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl GroupMessage --id 'devicegroupid' --msg \"message\" --title \"title\" --timeout 120000"));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [devicegroupid]     - The device identifier.");
                        } else {
                            console.log("  --id '[devicegroupid]'   - The device identifier.");
                        }
                        console.log("  --msg [message]          - The message to display.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --title [title]          - Messagebox title, default is \"MeshCentral\".");
                        console.log("  --timeout [miliseconds]  - After timeout messagebox vanishes, 0 keeps messagebox open until closed manually, default is 120000 (2 Minutes).");
                        break;
                    }
                    case 'grouptoast': {
                        console.log("Display a toast notification on remote devices in a specific device group, Example usages:\r\n");
                        console.log(winRemoveSingleQuotes("  MeshCtrl GroupToast --id 'devicegroupid' --msg \"message\""));
                        console.log(winRemoveSingleQuotes("  MeshCtrl GroupToast --id 'devicegroupid' --msg \"message\" --title \"title\""));
                        console.log("\r\nRequired arguments:\r\n");
                        if (process.platform == 'win32') {
                            console.log("  --id [devicegroupid]   - The device identifier.");
                        } else {
                            console.log("  --id '[devicegroupid]' - The device identifier.");
                        }
                        console.log("  --msg [message]        - The message to display.");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --title [title]        - Toast title, default is \"MeshCentral\".");
                        break;
                    }
                    case 'report': {
                        console.log("Generate a CSV report, Example usages:\r\n");
                        console.log("  MeshCtrl Report --type sessions --devicegroup mesh//...");
                        console.log("  MeshCtrl Report --type traffic --json");
                        console.log("  MeshCtrl Report --type logins --groupby day");
                        console.log("  MeshCtrl Report --type db");
                        console.log("\r\nOptional arguments:\r\n");
                        console.log("  --start [yyyy-mm-ddThh:mm:ss] - Filter the results starting at that date. Defaults to last 24h and last week when used with --groupby day. Usable with sessions, traffic and logins");
                        console.log("  --end [yyyy-mm-ddThh:mm:ss]   - Filter the results ending at that date. Defaults to now. Usable with sessions, traffic and logins");
                        console.log("  --groupby [name]              - How to group results. Options: user, day, device. Defaults to user. User and day usable in sessions and logins, device usable in sessions.");
                        console.log("  --devicegroup [devicegroupid] - Filter the results by device group. Usable in sessions");
                        console.log("  --showtraffic                 - Add traffic data in sessions report");
                        break;
                    }
                    default: {
                        console.log("Get help on an action. Type:\r\n\r\n  help [action]\r\n\r\nPossible actions are: " + possibleCommands.join(', ') + '.');
                    }
                }
            }
            break;
        }
    }

    if (ok) {
        if(args.loginpass===true){
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: false
            });
            process.stdout.write('Enter your password: ');
            const stdin = process.openStdin();
            stdin.setRawMode(true); // Set raw mode to prevent echoing of characters
            stdin.resume();
            args.loginpass = '';
            process.stdin.on('data', (char) => {
                char = char + '';
                switch (char) {
                    case '\n':
                    case '\r':
                    case '\u0004': // They've finished entering their password
                        stdin.setRawMode(false);
                        stdin.pause();
                        process.stdout.clearLine(); process.stdout.cursorTo(0);
                        rl.close();
                        serverConnect();
                        break;
                    case '\u0003': // Ctrl+C
                        process.stdout.write('\n');
                        process.exit();
                        break;
                    default: // Mask the password with "*"
                        args.loginpass += char;
                        process.stdout.clearLine(); process.stdout.cursorTo(0);
                        process.stdout.write('Enter your password: ' + '*'.repeat(args.loginpass.length));
                        break;
                }
            });
        }else{
            serverConnect();
        }
    }
}

function displayConfigHelp() {
    console.log("Perform operations on the config.json file. Example usage:\r\n");
    console.log("  MeshCtrl config --show");
    console.log("\r\nOptional arguments:\r\n");
    console.log("  --show                        - Display the config.json file.");
    console.log("  --listdomains                 - Display non-default domains.");
    console.log("  --adddomain [domain]          - Add a domain.");
    console.log("  --removedomain [domain]       - Remove a domain.");
    console.log("  --settodomain [domain]        - Set values to the domain.");
    console.log("  --removefromdomain [domain]   - Remove values from the domain.");
    console.log("\r\nWith adddomain, removedomain, settodomain and removefromdomain you can add the key and value pair. For example:\r\n");
    console.log("  --adddomain \"MyDomain\" --title \"My Server Name\" --newAccounts false");
    console.log("  --settodomain \"MyDomain\" --themePack \"Stylish-UI\"");
    console.log("  --settodomain \"MyDomain\" --title \"My Server Name\"");
    console.log("  --removefromdomain \"MyDomain\" --title");
}

function performConfigOperations(args) {
    var domainValues = ['title', 'title2', 'titlepicture', 'trustedcert', 'welcomepicture', 'welcometext', 'userquota', 'meshquota', 'newaccounts', 'usernameisemail', 'newaccountemaildomains', 'newaccountspass', 'newaccountsrights', 'geolocation', 'lockagentdownload', 'userconsentflags', 'Usersessionidletimeout', 'auth', 'ldapoptions', 'ldapusername', 'ldapuserbinarykey', 'ldapuseremail', 'footer', 'certurl', 'loginKey', 'userallowedip', 'agentallowedip', 'agentnoproxy', 'agentconfig', 'orphanagentuser', 'httpheaders', 'yubikey', 'passwordrequirements', 'limits', 'amtacmactivation', 'redirects', 'sessionrecording', 'hide', 'customFiles', 'themePack'];
    var domainObjectValues = ['ldapoptions', 'httpheaders', 'yubikey', 'passwordrequirements', 'limits', 'amtacmactivation', 'redirects', 'sessionrecording', 'customFiles'];
    var domainArrayValues = ['newaccountemaildomains', 'newaccountsrights', 'loginkey', 'agentconfig', 'themePack'];
    var configChange = false;
    var fs = require('fs');
    var path = require('path');
    var configFile = 'config.json';
    var didSomething = 0;
    if (fs.existsSync(configFile) == false) { configFile = path.join('meshcentral-data', 'config.json'); }
    if (fs.existsSync(configFile) == false) { configFile = path.join(__dirname, 'config.json'); }
    if (fs.existsSync(configFile) == false) { configFile = path.join(__dirname, 'meshcentral-data', 'config.json'); }
    if (fs.existsSync(configFile) == false) { configFile = path.join(__dirname, '..', 'meshcentral-data', 'config.json'); }
    if (fs.existsSync(configFile) == false) { configFile = path.join(__dirname, '..', '..', 'meshcentral-data', 'config.json'); }
    if (fs.existsSync(configFile) == false) { console.log("Unable to find config.json."); return; }
    var config = null;
    try { config = fs.readFileSync(configFile).toString('utf8'); } catch (ex) { console.log("Error: Unable to read config.json"); return; }
    try { config = JSON.parse(fs.readFileSync(configFile)); } catch (e) { console.log('ERROR: Unable to parse ' + configFile + '.'); return null; }
    if (args.adddomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (config.domains[args.adddomain] != null) { console.log("Error: Domain \"" + args.adddomain + "\" already exists"); }
        else {
            configChange = true;
            config.domains[args.adddomain] = {};
            for (var i in args) {
                if (domainValues.indexOf(i.toLowerCase()) >= 0) {
                    if (args[i] == 'true') { args[i] = true; } else if (args[i] == 'false') { args[i] = false; } else if (parseInt(args[i]) == args[i]) { args[i] = parseInt(args[i]); }
                    config.domains[args.adddomain][i] = args[i];
                    configChange = true;
                }
            }
        }
    }
    if (args.removedomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (config.domains[args.removedomain] == null) { console.log("Error: Domain \"" + args.removedomain + "\" does not exist"); }
        else { delete config.domains[args.removedomain]; configChange = true; }
    }
    if (args.settodomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (args.settodomain == true) { args.settodomain = ''; }
        if (config.domains[args.settodomain] == null) { console.log("Error: Domain \"" + args.settodomain + "\" does not exist"); }
        else {
            for (var i in args) {
                if ((i == '_') || (i == 'settodomain')) continue;
                if (domainValues.indexOf(i.toLowerCase()) >= 0) {
                    var isObj = (domainObjectValues.indexOf(i.toLowerCase()) >= 0);
                    var isArr = (domainArrayValues.indexOf(i.toLowerCase()) >= 0);
                    if ((isObj == false) && (isArr == false)) {
                        // Simple value set
                        if (args[i] == '') { delete config.domains[args.settodomain][i]; configChange = true; } else {
                            if (args[i] == 'true') { args[i] = true; } else if (args[i] == 'false') { args[i] = false; } else if (parseInt(args[i]) == args[i]) { args[i] = parseInt(args[i]); }
                            config.domains[args.settodomain][i] = args[i];
                            configChange = true;
                        }
                    } else if (isObj || isArr) {
                        // Set an object/array value
                        if (args[i] == '') { delete config.domains[args.settodomain][i]; configChange = true; } else {
                            var x = null;
                            try { x = JSON.parse(args[i]); } catch (ex) { }
                            if ((x == null) || (typeof x != 'object')) { console.log("Unable to parse JSON for " + i + "."); } else {
                                if (isArr && Array.isArray(x) == false) {
                                    console.log("Value " + i + " must be an array.");
                                } else if (!isArr && Array.isArray(x) == true) {
                                    console.log("Value " + i + " must be an object.");
                                } else {
                                    config.domains[args.settodomain][i] = x;
                                    configChange = true;
                                }
                            }
                        }
                    }
                } else {
                    console.log('Invalid configuration value: ' + i);
                }
            }
        }
    }
    if (args.removefromdomain != null) {
        didSomething++;
        if (config.domains == null) { config.domains = {}; }
        if (config.domains[args.removefromdomain] == null) { console.log("Error: Domain \"" + args.removefromdomain + "\" does not exist"); }
        else { for (var i in args) { if (domainValues.indexOf(i.toLowerCase()) >= 0) { delete config.domains[args.removefromdomain][i]; configChange = true; } } }
    }
    if (configChange) {
        try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2)); } catch (ex) { console.log("Error: Unable to read config.json"); return; }
    }
    if (args.show == 1) {
        console.log(JSON.stringify(config, null, 2)); return;
    } else if (args.listdomains == 1) {
        if (config.domains == null) {
            console.log('No domains found.'); return;
        } else {
            // Show the list of active domains, skip the default one.
            for (var i in config.domains) { if ((i != '') && (i[0] != '_')) { console.log(i); } } return;
        }
    } else {
        if (didSomething == 0) {
            displayConfigHelp();
        } else {
            console.log("Done.");
        }
    }
}

function onVerifyServer(clientName, certs) { return null; }

function serverConnect() {
    const { MeshCentralClient, redactCredentials } = require('./meshcentral-client');

    // The client owns the connection, authentication in all its modes, the
    // handshake and the startup discovery of server info, rights and version.
    var client = null;
    try {
        client = new MeshCentralClient({
            url: args.url,
            user: args.loginuser,
            password: args.loginpass,
            token: args.token,
            loginKey: args.loginkey,
            loginKeyFile: args.loginkeyfile,
            domain: args.logindomain,
            proxy: args.proxy,
            checkServerIdentity: onVerifyServer
        });
    } catch (ex) { console.log(redactCredentials(ex.message)); process.exit(); return; }
    client.connect().then(function open() {
        //console.log('Connected.');
        if (generatedCommand) {
            // The catalogue entry owns the requests and the rendering; the
            // shared executor issues them and this prints the result.
            cliDispatch.runRemote(client, catalogue.byName(settings.cmd), args).then(function () {
                process.exit();
            }, function (error) {
                console.log(redactCredentials((error != null) && (error.message != null) ? error.message : String(error)));
                process.exit();
            });
            return;
        }
        // Generated commands never reach here: they are dispatched from
        // their catalogue entry at the top of open(). These are the
        // enumerated exceptions, which keep their hand-written requests.
        switch (settings.cmd) {
            case 'listdevices': {
                if (args.details) {
                    // Get list of devices with lots of details
                    client.send(JSON.stringify({ action: 'getDeviceDetails', type: (args.csv) ? 'csv' : 'json' }));
                } else if (args.group) {
                    client.send(JSON.stringify({ action: 'nodes', meshname: args.group, responseid: 'meshctrl' }));
                } else if (args.id) {
                    client.send(JSON.stringify({ action: 'nodes', meshid: args.id, responseid: 'meshctrl' }));
                } else {
                    client.send(JSON.stringify({ action: 'meshes' }));
                    client.send(JSON.stringify({ action: 'nodes', responseid: 'meshctrl' }));
                }
                break;
            }
            case 'showevents': {
                console.log('Connected. Press ctrl-c to end.');
                break;
            }
            case 'editdevice': {
                if (args.addtag || args.removetag) {
                    // we need to fetch the node data first to then modify the tags
                    client.send(JSON.stringify({ action: 'nodes', id: args.id, responseid: 'meshctrl' }));
                } else {
                    var op = { action: 'changedevice', nodeid: args.id, responseid: 'meshctrl' };
                    if (typeof args.name == 'string') { op.name = args.name; }
                    if (typeof args.name == 'number') { op.name = '' + args.name; }
                    if (args.desc) { if (args.desc === true) { op.desc = ''; } else if (typeof args.desc == 'string') { op.desc = args.desc; } else if (typeof args.desc == 'number') { op.desc = '' + args.desc; } }
                    if (args.tags) { if (args.tags === true) { op.tags = ''; } else if (typeof args.tags == 'string') { op.tags = args.tags.split(','); } else if (typeof args.tags == 'number') { op.tags = '' + args.tags; } }
                    if (args.icon) { op.icon = parseInt(args.icon); if ((typeof op.icon != 'number') || isNaN(op.icon) || (op.icon < 1) || (op.icon > 8)) { console.log("Icon must be between 1 and 8."); process.exit(1); return; } }
                    if (args.consent) { op.consent = parseInt(args.consent); if ((typeof op.consent != 'number') || isNaN(op.consent) || (op.consent < 1)) { console.log("Invalid consent flags."); process.exit(1); return; } }
                    client.send(JSON.stringify(op));
                }
                break;
            }
            case 'shell':
            case 'upload':
            case 'download': {
                client.send("{\"action\":\"authcookie\"}");
                break;
            }
        }
    }).catch(function () { }); // Connection failures are reported through the client's close and error events.

    client.on('close', function () { process.exit(); });
    client.on('error', function (err) {
        // The client maps transport errors to actionable messages and keeps
        // credentials out of them.
        console.log(redactCredentials(err.message));
        process.exit();
    });

    client.on('message', function incoming(rawdata) {
        // Generated commands have no branch here: cli-dispatch.js owns their
        // responses and rendering. The exception commands below keep theirs.
        if (generatedCommand) { return; }
        var data = null;
        try { data = JSON.parse(rawdata); } catch (ex) { }
        if (data == null) { console.log('Unable to parse data: ' + rawdata); }
        if (settings.cmd == 'showevents') {
            if (args.filter == null) {
                // Display all events
                console.log(JSON.stringify(data, null, 2));
            } else {
                // Display select events
                var filters = args.filter.split(',');
                if (typeof data.event == 'object') {
                    if (filters.indexOf(data.event.action) >= 0) { console.log(JSON.stringify(data, null, 2) + '\r\n'); }
                } else {
                    if (filters.indexOf(data.action) >= 0) { console.log(JSON.stringify(data, null, 2) + '\r\n'); }
                }
            }
            return;
        }
        switch (data.action) {
            case 'serverinfo': { // SERVERINFO
                // The login domain completes bare device ids for the tunnels.
                settings.currentDomain = data.serverinfo.domain;
                break;
            }
            case 'authcookie': { // SHELL, UPLOAD, DOWNLOAD
                if ((settings.cmd == 'shell') || (settings.cmd == 'upload') || (settings.cmd == 'download')) {
                    var protocol = 1; // Terminal
                    if ((settings.cmd == 'upload') || (settings.cmd == 'download')) { protocol = 5; } // Files
                    if (args.powershell) { protocol = 6; } // PowerShell
                    if ((args.id.split('/').length != 3) && (settings.currentDomain != null)) { args.id = 'node/' + settings.currentDomain + '/' + args.id; }
                    var id = getRandomHex(6);
                    client.send(JSON.stringify({ action: 'msg', nodeid: args.id, type: 'tunnel', usage: 1, value: '*/meshrelay.ashx?p=' + protocol + '&nodeid=' + args.id + '&id=' + id + '&rauth=' + data.rcookie, responseid: 'meshctrl' }));
                    connectTunnel(client.url.replace('/control.ashx', '/meshrelay.ashx?browser=1&p=' + protocol + '&nodeid=' + encodeURIComponent(args.id) + '&id=' + id + '&auth=' + data.cookie));
                }
                break;
            }
            case 'msg': // SHELL, UPLOAD, DOWNLOAD
            case 'changedevice': { // EDITDEVICE
                if (((settings.cmd == 'shell') || (settings.cmd == 'upload') || (settings.cmd == 'download')) && (data.result == 'OK')) return;
                if (data.responseid == 'meshctrl') {
                    if (data.meshid) { console.log(data.result, data.meshid); }
                    else if (data.userid) { console.log(data.result, data.userid); }
                    else console.log(data.result);
                    process.exit();
                }
                break;
            }
            case 'nodes': {
                if ((settings.cmd == 'listdevices') && (data.responseid == 'meshctrl')) {
                    if ((data.result != null) && (data.result != 'ok')) {
                        console.log(data.result);
                    } else {
                        // Filter devices based on device id.
                        if (args.filterid) {
                            var filteridSplit = args.filterid.split(','), filters = [];
                            for (var i in filteridSplit) {
                                var f = filteridSplit[i].trim();
                                var g = f.split('/'); // If there is any / in the id, just grab the last part.
                                if (g.length > 0) { f = g[g.length - 1]; }
                                if (f != '') { filters.push(f); }
                            }
                            if (filters.length > 0) {
                                for (var mid in data.nodes) {
                                    var filteredNodes = [];
                                    for (var nid in data.nodes[mid]) {
                                        var n = data.nodes[mid][nid], match = false;
                                        for (var f in filters) { if (n._id.indexOf(filters[f]) >= 0) { match = true; } }
                                        if (match) { filteredNodes.push(n); }
                                    }
                                    data.nodes[mid] = filteredNodes;
                                }
                            }
                        }

                        // Filter devices based on filter string
                        if (args.filter != null) {
                            for (var meshid in data.nodes) {
                                for (var d in data.nodes[meshid]) { data.nodes[meshid][d].meshid = meshid; }
                                data.nodes[meshid] = parseSearchOrInput(data.nodes[meshid], args.filter.toString().toLowerCase());
                            }
                        }

                        if (args.csv) {
                            // Return a flat list
                            var nodecount = 0;
                            for (var i in data.nodes) {
                                var devicesInMesh = data.nodes[i];
                                for (var j in devicesInMesh) {
                                    var n = devicesInMesh[j];
                                    nodecount++;
                                    if (settings.xmeshes && settings.xmeshes[i]) {
                                        console.log('\"' + settings.xmeshes[i]._id.split('/')[2] + '\",\"' + settings.xmeshes[i].name.split('\"').join('') + '\",\"' + n._id.split('/')[2] + '\",\"' + n.name.split('\"').join('') + '\",' + (n.icon ? n.icon : 0) + ',' + (n.conn ? n.conn : 0) + ',' + (n.pwr ? n.pwr : 0));
                                    } else {
                                        console.log('\"\",\"\",\"' + n._id.split('/')[2] + '\",\"' + n.name.split('\"').join('') + '\",' + (n.icon ? n.icon : 0) + ',' + (n.conn ? n.conn : 0) + ',' + (n.pwr ? n.pwr : 0));
                                    }
                                }
                            }
                            if (nodecount == 0) { console.log('None'); }
                        } else if (args.count) {
                            // Return how many devices are in this group
                            var nodes = [];
                            for (var i in data.nodes) { var devicesInMesh = data.nodes[i]; for (var j in devicesInMesh) { nodes.push(devicesInMesh[j]); } }
                            console.log(nodes.length);
                        } else if (args.json) {
                            // Return all devices in JSON format
                            var nodes = [];

                            for (var i in data.nodes) {
                                const devicesInMesh = data.nodes[i];
                                for (var j in devicesInMesh) {
                                    devicesInMesh[j].meshid = i; // Add device group id
                                    if (settings.xmeshes && settings.xmeshes[i] && settings.xmeshes[i].name) { devicesInMesh[j].groupname = settings.xmeshes[i].name; } // Add device group name
                                    nodes.push(devicesInMesh[j]);
                                }
                            }
                            console.log(JSON.stringify(nodes, ' ', 2));
                        } else {
                            // Display the list of nodes in text format
                            var nodecount = 0;
                            for (var i in data.nodes) {
                                var devicesInMesh = data.nodes[i];
                                if (devicesInMesh.length > 0) {
                                    if (settings.xmeshes && settings.xmeshes[i] && settings.xmeshes[i].name) { console.log('\r\nDevice group: \"' + settings.xmeshes[i].name.split('\"').join('') + '\"'); }
                                    console.log('id, name, icon, conn, pwr\r\n-------------------------');
                                    for (var j in devicesInMesh) {
                                        var n = devicesInMesh[j];
                                        nodecount++;
                                        console.log('\"' + n._id.split('/')[2] + '\", \"' + n.name.split('\"').join('') + '\", ' + (n.icon ? n.icon : 0) + ', ' + (n.conn ? n.conn : 0) + ', ' + (n.pwr ? n.pwr : 0));
                                    }
                                }
                            }
                            if (nodecount == 0) { console.log('None'); }
                        }
                    }
                    process.exit();
                }
                if ((settings.cmd == 'editdevice') && (data.responseid == 'meshctrl')) {
                    // Find the node to get its current tags
                    var targetNode = null;
                    for (var i in data.nodes) {
                        for (var j in data.nodes[i]) {
                            if (data.nodes[i][j]._id == args.id) { targetNode = data.nodes[i][j]; break; }
                        }
                        if (targetNode != null) { break; }
                    }
                    if (targetNode == null) {
                        console.log('Node not found.');
                        process.exit();
                        return;
                    }
                    // Start with current tags or empty array
                    var tags = (Array.isArray(targetNode.tags)) ? targetNode.tags.slice() : [];
                    // Add tags: --addtag tag1,tag2
                    if (args.addtag) {
                        var addtags = (typeof args.addtag == 'string') ? args.addtag.split(',') : ['' + args.addtag];
                        for (var i in addtags) { var t = addtags[i].trim(); if (t && (tags.indexOf(t) < 0)) { tags.push(t); } }
                    }
                    // Remove tags: --removetag tag1,tag2
                    if (args.removetag) {
                        var removetags = (typeof args.removetag == 'string') ? args.removetag.split(',') : ['' + args.removetag];
                        var removetrimmed = removetags.map(function(r) { return r.trim(); });
                        tags = tags.filter(function(t) { return removetrimmed.indexOf(t) < 0; });
                    }
                    // Build and send the changedevice op
                    var op = { action: 'changedevice', nodeid: args.id, responseid: 'meshctrl' };
                    if (typeof args.name == 'string') { op.name = args.name; }
                    if (typeof args.name == 'number') { op.name = '' + args.name; }
                    if (args.desc) { if (args.desc === true) { op.desc = ''; } else if (typeof args.desc == 'string') { op.desc = args.desc; } else if (typeof args.desc == 'number') { op.desc = '' + args.desc; } }
                    if (args.icon) { op.icon = parseInt(args.icon); if ((typeof op.icon != 'number') || isNaN(op.icon) || (op.icon < 1) || (op.icon > 8)) { console.log("Icon must be between 1 and 8."); process.exit(1); return; } }
                    if (args.consent) { op.consent = parseInt(args.consent); if ((typeof op.consent != 'number') || isNaN(op.consent) || (op.consent < 1)) { console.log("Invalid consent flags."); process.exit(1); return; } }
                    op.tags = tags;
                    client.send(JSON.stringify(op));
                }
                break;
            }
            case 'meshes': { // LISTDEVICES
                if (settings.cmd == 'listdevices') {
                    // Store the list of device groups for later use
                    settings.xmeshes = {}
                    for (var i in data.meshes) { settings.xmeshes[data.meshes[i]._id] = data.meshes[i]; }
                }
                break;
            }
            case 'close': {
                if (data.cause == 'noauth') {
                    if (data.msg == 'tokenrequired') {
                        console.log('Authentication token required, use --token [number].');
                    } else if (data.msg == 'nokey') {
                        console.log('URL key is invalid or missing, please specify ?key=xxx in url');
                    } else {
                        if ((args.loginkeyfile != null) || (args.loginkey != null)) {
                            console.log('Invalid login, check the login key and that this computer has the correct time.');
                        } else {
                            console.log('Invalid login.');
                        }
                    }
                } else if (data.cause == 'locked') {
                    console.log('Account locked. Please contact the administrator.');
                } else if (data.cause == 'banned') {
                    console.log('Access temporarily blocked due to too many failed login attempts.');
                }
                process.exit();
                break;
            }
            case 'getDeviceDetails': {
                console.log(data.data);
                process.exit();
            }
            default: { break; }
        }
        //console.log('Data', data);
        //setTimeout(function timeout() { client.send(Date.now()); }, 500);
    });
}

function parseSearchAndInput(nodes, x) {
    var s = x.split(' ' + "and" + ' '), r = null;
    for (var i in s) {
        var r2 = getDevicesThatMatchFilter(nodes, s[i]);
        if (r == null) { r = r2; } else { var r3 = []; for (var j in r2) { if (r.indexOf(r2[j]) >= 0) { r3.push(r2[j]); } } r = r3; }
    }
    return r;
}

function parseSearchOrInput(nodes, x) {
    var s = x.split(' ' + "or" + ' '), r = null;
    for (var i in s) { var r2 = parseSearchAndInput(nodes, s[i]); if (r == null) { r = r2; } else { for (var j in r2) { if (r.indexOf(r2[j] >= 0)) { r.push(r2[j]); } } } }
    return r;
}

function getDevicesThatMatchFilter(nodes, x) {
    var r = [];
    var userSearch = null, ipSearch = null, groupSearch = null, tagSearch = null, agentTagSearch = null, wscSearch = null, osSearch = null, amtSearch = null, descSearch = null;
    if (x.startsWith("user:".toLowerCase())) { userSearch = x.substring("user:".length); }
    else if (x.startsWith("u:".toLowerCase())) { userSearch = x.substring("u:".length); }
    else if (x.startsWith("ip:".toLowerCase())) { ipSearch = x.substring("ip:".length); }
    else if (x.startsWith("group:".toLowerCase())) { groupSearch = x.substring("group:".length); }
    else if (x.startsWith("g:".toLowerCase())) { groupSearch = x.substring("g:".length); }
    else if (x.startsWith("tag:".toLowerCase())) { tagSearch = x.substring("tag:".length); }
    else if (x.startsWith("t:".toLowerCase())) { tagSearch = x.substring("t:".length); }
    else if (x.startsWith("atag:".toLowerCase())) { agentTagSearch = x.substring("atag:".length); }
    else if (x.startsWith("a:".toLowerCase())) { agentTagSearch = x.substring("a:".length); }
    else if (x.startsWith("os:".toLowerCase())) { osSearch = x.substring("os:".length); }
    else if (x.startsWith("amt:".toLowerCase())) { amtSearch = x.substring("amt:".length); }
    else if (x.startsWith("desc:".toLowerCase())) { descSearch = x.substring("desc:".length); }
    else if (x == 'wsc:ok') { wscSearch = 1; }
    else if (x == 'wsc:noav') { wscSearch = 2; }
    else if (x == 'wsc:noupdate') { wscSearch = 3; }
    else if (x == 'wsc:nofirewall') { wscSearch = 4; }
    else if (x == 'wsc:any') { wscSearch = 5; }

    if (x == '') {
        // No search
        for (var d in nodes) { r.push(nodes[d]); }
    } else if (ipSearch != null) {
        // IP address search
        for (var d in nodes) { if ((nodes[d].ip != null) && (nodes[d].ip.indexOf(ipSearch) >= 0)) { r.push(nodes[d]); } }
    } else if (groupSearch != null) {
        // Group filter
        if (settings.xmeshes) { for (var d in nodes) { if (settings.xmeshes[nodes[d].meshid] && settings.xmeshes[nodes[d].meshid].name.toLowerCase().indexOf(groupSearch) >= 0) { r.push(nodes[d]); } } }
    } else if (tagSearch != null) {
        // Tag filter
        for (var d in nodes) {
            if ((nodes[d].tags == null) && (tagSearch == '')) { r.push(nodes[d]); }
            else if (nodes[d].tags != null) { for (var j in nodes[d].tags) { if (nodes[d].tags[j].toLowerCase() == tagSearch) { r.push(nodes[d]); break; } } }
        }
    } else if (agentTagSearch != null) {
        // Agent Tag filter
        for (var d in nodes) {
            if ((((nodes[d].agent != null) && (nodes[d].agent.tag == null)) && (agentTagSearch == '')) || ((nodes[d].agent != null) && (nodes[d].agent.tag != null) && (nodes[d].agent.tag.toLowerCase().indexOf(agentTagSearch) >= 0))) { r.push(nodes[d]); };
        }
    } else if (userSearch != null) {
        // User search
        for (var d in nodes) {
            if (nodes[d].users && nodes[d].users.length > 0) { for (var i in nodes[d].users) { if (nodes[d].users[i].toLowerCase().indexOf(userSearch) >= 0) { r.push(nodes[d]); } } }
        }
    } else if (osSearch != null) {
        // OS search
        for (var d in nodes) { if ((nodes[d].osdesc != null) && (nodes[d].osdesc.toLowerCase().indexOf(osSearch) >= 0)) { r.push(nodes[d]); }; }
    } else if (amtSearch != null) {
        // Intel AMT search
        for (var d in nodes) { if ((nodes[d].intelamt != null) && ((amtSearch == '') || (nodes[d].intelamt.state == amtSearch))) { r.push(nodes[d]); } }
    } else if (descSearch != null) {
        // Device description search
        for (var d in nodes) { if ((nodes[d].desc != null) && (nodes[d].desc != '') && ((descSearch == '') || (nodes[d].desc.toLowerCase().indexOf(descSearch) >= 0))) { r.push(nodes[d]); } }
    } else if (wscSearch != null) {
        // Windows Security Center
        for (var d in nodes) {
            if (nodes[d].wsc) {
                if ((wscSearch == 1) && (nodes[d].wsc.antiVirus == 'OK') && (nodes[d].wsc.autoUpdate == 'OK') && (nodes[d].wsc.firewall == 'OK')) { r.push(nodes[d]); }
                else if (((wscSearch == 2) || (wscSearch == 5)) && (nodes[d].wsc.antiVirus != 'OK')) { r.push(nodes[d]); }
                else if (((wscSearch == 3) || (wscSearch == 5)) && (nodes[d].wsc.autoUpdate != 'OK')) { r.push(nodes[d]); }
                else if (((wscSearch == 4) || (wscSearch == 5)) && (nodes[d].wsc.firewall != 'OK')) { r.push(nodes[d]); }
            }
        }
    } else if (x == '*') {
        // Star filter
        for (var d in nodes) { if (stars[nodes[d]._id] == 1) { r.push(nodes[d]); } }
    } else {
        // Device name search
        try {
            var rs = x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), rx = new RegExp(rs); // In some cases (like +), this can throw an exception.
            for (var d in nodes) {
                //if (showRealNames) {
                //if (nodes[d].rnamel != null && rx.test(nodes[d].rnamel.toLowerCase())) { r.push(nodes[d]); }
                //} else {
                if (rx.test(nodes[d].name.toLowerCase())) { r.push(nodes[d]); }
                //}
            }
        } catch (ex) { for (var d in nodes) { r.push(nodes[d]); } }
    }

    return r;
}


// Connect tunnel to a remote agent
function connectTunnel(url) {
    const { redactCredentials } = require('./meshcentral-client');
    // Setup WebSocket options
    var options = { rejectUnauthorized: false, checkServerIdentity: onVerifyServer }

    // Setup the HTTP proxy if needed
    if (args.proxy != null) { const HttpsProxyAgent = require('https-proxy-agent'); options.agent = new HttpsProxyAgent(new URL(args.proxy)); }

    // Connect the WebSocket
    console.log('Connecting...');
    const WebSocket = require('ws');
    settings.tunnelwsstate = 0;
    settings.tunnelws = new WebSocket(url, options);
    settings.tunnelws.on('open', function () { console.log('Waiting for Agent...'); }); // Wait for agent connection
    settings.tunnelws.on('close', function () { console.log('Connection Closed.'); process.exit(); });
    settings.tunnelws.on('error', function (err) { console.log(redactCredentials(((err != null) && (err.message != null)) ? err.message : String(err))); process.exit(); });

    if (settings.cmd == 'shell') {
        // This code does all of the work for a shell command
        settings.tunnelws.on('message', function (rawdata) {
            var data = rawdata.toString();
            if (settings.tunnelwsstate == 1) {
                // If the incoming text looks exactly like a control command, ignore it.
                if ((typeof data == 'string') && (data.startsWith('{"ctrlChannel":"102938","type":"'))) {
                    var ctrlCmd = null;
                    try { ctrlCmd = JSON.parse(data); } catch (ex) { }
                    if ((ctrlCmd != null) && (ctrlCmd.ctrlChannel == '102938') && (ctrlCmd.type != null)) return; // This is a control command, like ping/pong. Ignore it.
                }
                process.stdout.write(data);
            } else if (settings.tunnelwsstate == 0) {
                if (data == 'c') { console.log('Connected.'); } else if (data == 'cr') { console.log('Connected, session is being recorded.'); } else return;
                // Send terminal size
                var termSize = null;
                if (typeof process.stdout.getWindowSize == 'function') { termSize = process.stdout.getWindowSize(); }
                if (termSize != null) { settings.tunnelws.send(JSON.stringify({ ctrlChannel: '102938', type: 'options', cols: termSize[0], rows: termSize[1] })); }
                settings.tunnelwsstate = 1;
                settings.tunnelws.send((args.powershell ? 6 : 1)); // Powershell or Terminal
                process.stdin.setEncoding('utf8');
                process.stdin.setRawMode(true);
                process.stdout.setEncoding('utf8');
                process.stdin.unpipe(process.stdout);
                process.stdout.unpipe(process.stdin);
                process.stdin.on('data', function (data) { settings.tunnelws.send(Buffer.from(data)); });
                //process.stdin.on('readable', function () { var chunk; while ((chunk = process.stdin.read()) !== null) { settings.tunnelws.send(Buffer.from(chunk)); } });
                process.stdin.on('end', function () { process.exit(); });
                process.stdout.on('resize', function () {
                    var termSize = null;
                    if (typeof process.stdout.getWindowSize == 'function') { termSize = process.stdout.getWindowSize(); }
                    if (termSize != null) { settings.tunnelws.send(JSON.stringify({ ctrlChannel: '102938', type: 'termsize', cols: termSize[0], rows: termSize[1] })); }
                });
            }
        });
    } else if (settings.cmd == 'upload') {
        // This code does all of the work for a file upload
        // node meshctrl upload --id oL4Y6Eg0qjnpHFrp1AxfxnBPenbDGnDSkC@HSOnAheIyd51pKhqSCUgJZakzwfKl --file readme.md --target c:\
        settings.tunnelws.on('message', function (rawdata) {
            if (settings.tunnelwsstate == 1) {
                var cmd = null;
                try { cmd = JSON.parse(rawdata.toString()); } catch (ex) { return; }
                if (cmd.reqid == 'up') {
                    if ((cmd.action == 'uploadack') || (cmd.action == 'uploadstart')) {
                        settings.inFlight--;
                        if (settings.uploadFile == null) { if (settings.inFlight == 0) { process.exit(); } return; } // If the file is closed and there is no more in-flight data, exit.
                        var loops = (cmd.action == 'uploadstart') ? 16 : 1; // If this is the first data to be sent, hot start now. We are going to have 16 blocks of data in-flight.
                        for (var i = 0; i < loops; i++) {
                            if (settings.uploadFile == null) continue;
                            var buf = Buffer.alloc(65565);
                            var len = require('fs').readSync(settings.uploadFile, buf, 1, 65564, settings.uploadPtr);
                            var start = 1;
                            settings.uploadPtr += len;
                            if (len > 0) {
                                if ((buf[1] == 0) || (buf[1] == 123)) { start = 0; buf[0] = 0; len++; } // If the buffer starts with 0 or 123, we must add an extra 0 at the start of the buffer
                                settings.inFlight++;
                                settings.tunnelws.send(buf.slice(start, start + len));
                            } else {
                                console.log('Upload done, ' + settings.uploadPtr + ' bytes sent.');
                                if (settings.uploadFile != null) { require('fs').closeSync(settings.uploadFile); delete settings.uploadFile; }
                                if (settings.inFlight == 0) { process.exit(); return; } // File is closed, if there is no more in-flight data, exit.
                            }
                        }

                    } else if (cmd.action == 'uploaderror') {
                        if (settings.uploadFile != null) { require('fs').closeSync(settings.uploadFile); }
                        console.log('Upload error.');
                        process.exit();
                    }
                }
            } else if (settings.tunnelwsstate == 0) {
                var data = rawdata.toString();
                if (data == 'c') { console.log('Connected.'); } else if (data == 'cr') { console.log('Connected, session is being recorded.'); } else return;
                settings.tunnelwsstate = 1;
                settings.tunnelws.send('5'); // Files
                settings.uploadSize = require('fs').statSync(args.file).size;
                settings.uploadFile = require('fs').openSync(args.file, 'r');
                settings.uploadPtr = 0;
                settings.inFlight = 1;
                console.log('Uploading...');
                settings.tunnelws.send(JSON.stringify({ action: 'upload', reqid: 'up', path: args.target, name: require('path').basename(args.file), size: settings.uploadSize }));
            }
        });
    } else if (settings.cmd == 'download') {
        // This code does all of the work for a file download
        // node meshctrl download --id oL4Y6Eg0qjnpHFrp1AxfxnBPenbDGnDSkC@HSOnAheIyd51pKhqSCUgJZakzwfKl --file c:\temp\MC-8Languages.png --target c:\temp\bob.png
        settings.tunnelws.on('message', function (rawdata) {
            if (settings.tunnelwsstate == 1) {
                if ((rawdata.length > 0) && (rawdata.toString()[0] != '{')) {
                    // This is binary data, this test is ok because 4 first bytes is a control value.
                    if ((rawdata.length > 4) && (settings.downloadFile != null)) { settings.downloadSize += (rawdata.length - 4); require('fs').writeSync(settings.downloadFile, rawdata, 4, rawdata.length - 4); }
                    if ((rawdata[3] & 1) != 0) { // Check end flag
                        // File is done, close everything.
                        if (settings.downloadFile != null) { require('fs').closeSync(settings.downloadFile); }
                        console.log('Download completed, ' + settings.downloadSize + ' bytes written.');
                        process.exit();
                    } else {
                        settings.tunnelws.send(JSON.stringify({ action: 'download', sub: 'ack', id: args.file })); // Send the ACK
                    }
                } else {
                    // This is text data
                    var cmd = null;
                    try { cmd = JSON.parse(rawdata.toString()); } catch (ex) { return; }
                    if (cmd.action == 'download') {
                        if (cmd.id != args.file) return;
                        if (cmd.sub == 'start') {
                            if ((args.target.endsWith('\\')) || (args.target.endsWith('/'))) { args.target += path.parse(args.file).name; }
                            try { settings.downloadFile = require('fs').openSync(args.target, 'w'); } catch (ex) { console.log("Unable to create file: " + args.target); process.exit(); return; }
                            settings.downloadSize = 0;
                            settings.tunnelws.send(JSON.stringify({ action: 'download', sub: 'startack', id: args.file }));
                            console.log('Download started: ' + args.target);
                        } else if (cmd.sub == 'cancel') {
                            if (settings.downloadFile != null) { require('fs').closeSync(settings.downloadFile); }
                            console.log('Download canceled.');
                            process.exit();
                        }
                    }
                }
            } else if (settings.tunnelwsstate == 0) {
                var data = rawdata.toString();
                if (data == 'c') { console.log('Connected.'); } else if (data == 'cr') { console.log('Connected, session is being recorded.'); } else return;
                settings.tunnelwsstate = 1;
                settings.tunnelws.send('5'); // Files
                settings.tunnelws.send(JSON.stringify({ action: 'download', sub: 'start', id: args.file, path: args.file }));
            }
        });
    }
}

function getRandomHex(count) { return Buffer.from(crypto.randomBytes(count), 'binary').toString('hex'); }
function winRemoveSingleQuotes(str) { if (process.platform != 'win32') return str; else return str.split('\'').join(''); }
