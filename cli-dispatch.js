'use strict';

/**
 * @description Catalogue-driven dispatch for the meshctrl CLI.
 *
 * Every command the catalogue can express runs through here: the declared
 * arguments become the command arguments, the declared checks become the
 * missing-argument messages, the declared protocol mapping becomes the
 * requests, and the declared cli.format becomes the printed bytes. meshctrl.js
 * keeps only the commands on the exception list below, which are enumerated
 * with the reason the catalogue cannot express them.
 *
 * The MCP bridge runs the same protocol mappings through
 * protocol-executor.js, so a catalogue entry drives both surfaces.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const catalogue = require('./command-catalogue.js');
const { executeProtocol } = require('./protocol-executor.js');

/**
* CLI behaviours the catalogue cannot express, with the reason. These command
* names keep their hand-written meshctrl implementation; everything else with
* a protocol mapping is dispatched from its catalogue entry. The parity test
* fails when a catalogue command is neither generated nor listed here.
*/
const CLI_EXCEPTIONS = {
    config: 'The CLI accepts free-form domain value flags (--title, --newAccounts and the like) whose key and value cannot be declared as fixed arguments; the catalogue entry carries only the operation flags.',
    editdevice: 'A bare --desc clears the description and a bare --tags clears the tags; the catalogue argument schema carries them as text because an MCP tool argument cannot distinguish "absent" from "empty".',
    listdevices: 'The CLI sends an extra meshes request to render device group headings, and its --details, --csv, --json and --filterid listing modes shape the same nodes response in ways the tool surface does not.',
    showevents: 'The CLI streams the server event feed until interrupted; the catalogue entry returns the server snapshot for the bridge.',
    shell: 'The CLI opens an interactive terminal tunnel; the catalogue entry runs a single command to completion for the bridge.',
    upload: 'File transfer is deliberately without a tool surface (the entry is omitted), so the interactive upload tunnel has no catalogue protocol to run.',
    download: 'File transfer is deliberately without a tool surface (the entry is omitted), so the interactive download tunnel has no catalogue protocol to run.'
};

/** The CLI flag a declared argument is read from. */
function cliFlag(arg) {
    return (arg.cli != null) ? arg.cli : arg.name;
}

/** True when the command is dispatched from its catalogue entry. */
function isGenerated(entry) {
    return (entry != null) && (entry.protocol != null) && (CLI_EXCEPTIONS[entry.name] == null);
}

/** True when the command runs on this host without a server connection. */
function isLocal(entry) {
    return (entry.protocol != null) && !Array.isArray(entry.protocol) && (entry.protocol.local != null);
}

/** Build the declared command arguments from a minimist parse of argv. */
function buildArguments(entry, argv) {
    const args = {};
    for (const arg of entry.args) {
        const value = argv[cliFlag(arg)];
        if (value === undefined) { continue; }
        args[arg.name] = value;
    }
    if ((entry.cli != null) && (entry.cli.prepare != null)) { entry.cli.prepare(args, argv); }
    return args;
}

/** Remove the quotes meshctrl removes from its messages on Windows. */
function winRemoveSingleQuotes(text) {
    return (process.platform === 'win32') ? String(text).split("'").join('') : String(text);
}

/**
* The message the CLI prints when the command arguments are incomplete, or
* null when they pass. The entry's checks run in order; without checks the
* required arguments are checked in declaration order and the message comes
* from arg.cliMessage, falling back to a generated text for new entries.
*/
function validationMessage(entry, args) {
    if ((entry.cli != null) && (entry.cli.checks != null)) {
        for (const check of entry.cli.checks) {
            let ok = true;
            if (check.arg != null) { ok = (args[check.arg] != null); }
            else if (check.anyOf != null) { ok = check.anyOf.some((name) => (args[name] != null)); }
            else if (check.test != null) { ok = (check.test(args) === true); }
            if (!ok) { return winRemoveSingleQuotes(check.message); }
        }
        return null;
    }
    for (const arg of entry.args) {
        if ((arg.required !== true) || (args[arg.name] != null)) { continue; }
        const message = (arg.cliMessage != null) ? arg.cliMessage : ('Missing ' + cliFlag(arg) + ' argument.');
        return winRemoveSingleQuotes(message);
    }
    return null;
}

/** Render a command value with the entry's CLI formatter. */
function formatResult(entry, value, args, argv) {
    if ((entry.cli == null) || (entry.cli.format == null)) { return null; }
    return entry.cli.format(value, args, argv);
}

/**
* Run a local command (indexagenterrorlog) and print its rendering. Resolves
* without printing when the formatter asks for silence.
*/
async function runLocal(entry, argv) {
    const args = buildArguments(entry, argv);
    const value = await executeProtocol(null, entry, args);
    const text = formatResult(entry, value, args, argv);
    if (text != null) { console.log(text); }
}

/**
* Run a connected command: execute the protocol mapping, then print the
* rendering. Rejects with the executor's error, which the caller surfaces.
*/
async function runRemote(client, entry, argv) {
    const args = buildArguments(entry, argv);
    const value = await executeProtocol(client, entry, args);
    const text = formatResult(entry, value, args, argv);
    if (text != null) { console.log(text); }
}

/** The generated catalogue entries, in catalogue order. */
function generatedCommands() {
    return catalogue.commands.filter((entry) => isGenerated(entry));
}

module.exports = {
    CLI_EXCEPTIONS: CLI_EXCEPTIONS,
    cliFlag: cliFlag,
    isGenerated: isGenerated,
    isLocal: isLocal,
    buildArguments: buildArguments,
    validationMessage: validationMessage,
    formatResult: formatResult,
    runLocal: runLocal,
    runRemote: runRemote,
    generatedCommands: generatedCommands
};
