'use strict';

/**
 * Tests for the shared command catalogue: declaration shape, the CLI
 * generation promise and the mapping onto the MCP tool surface.
 *
 * meshctrl.js executes on require (it parses process.argv and may exit), so the
 * CLI is exercised as a subprocess, never imported. The generated dispatch and
 * the requests it sends are pinned by cli-catalogue-parity.test.js; this file
 * guards the declarations themselves and the exception list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const catalogue = require('../command-catalogue.js');
const cliDispatch = require('../cli-dispatch.js');

const MESHCTRL = path.join(__dirname, '..', 'meshctrl.js');
const FAMILIES = ['inspection', 'device', 'admin', 'local'];
const ARG_TYPES = ['string', 'number', 'boolean'];

/**
* Ask the CLI for its command list the way an operator sees it: run an
* unknown command and read the "Possible commands are:" line. This does not
* connect to a server.
*/
function cliCommandList() {
    const result = spawnSync(process.execPath, [MESHCTRL, '__catalogue_parity_probe__'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/Possible commands are: (.*)\./);
    assert.ok(match != null, 'meshctrl printed its command list, got: ' + JSON.stringify(result.stdout));
    return match[1].split(', ');
}

test('requiring the catalogue has no side effects', () => {
    const result = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(require.resolve('../command-catalogue.js')) + ')'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
});

test('requiring the CLI dispatch has no side effects', () => {
    const result = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(require.resolve('../cli-dispatch.js')) + ')'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
});

test('the CLI command list is rendered from the catalogue, same names and order', () => {
    assert.deepEqual(catalogue.commandNames(), cliCommandList());
});

test('command names are unique and commandNames returns a copy', () => {
    const names = catalogue.commandNames();
    assert.equal(new Set(names).size, names.length);
    names.push('not-a-command');
    assert.equal(catalogue.commandNames().includes('not-a-command'), false);
});

test('every entry declares a name, description, family and CLI mapping', () => {
    for (const entry of catalogue.commands) {
        assert.match(entry.name, /^[a-z][a-z0-9]*$/, entry.name);
        assert.equal(typeof entry.description, 'string');
        assert.ok(entry.description.length > 10, entry.name + ' has a description');
        assert.ok(FAMILIES.includes(entry.family), entry.name + ' family ' + entry.family);
        assert.ok(entry.cli != null, entry.name + ' cli mapping');
        assert.equal(entry.cli.name, entry.name);
        assert.ok(Array.isArray(entry.args), entry.name + ' args array');
    }
});

test('every covered command declares arguments, auth metadata, a protocol mapping and a format', () => {
    const covered = catalogue.mcpCommands();
    assert.ok(covered.length > 0);
    for (const entry of covered) {
        assert.match(entry.mcp.name, /^mesh_[a-z0-9_]+$/, entry.name + ' tool name');
        assert.ok(entry.auth != null, entry.name + ' auth metadata');
        assert.equal(entry.auth.user, true, entry.name + ' auth.user');
        assert.ok(Array.isArray(entry.auth.rights), entry.name + ' auth.rights');
        assert.ok(entry.protocol != null, entry.name + ' protocol mapping');
        assert.equal(typeof entry.format, 'function', entry.name + ' format');
        for (const arg of entry.args) {
            assert.match(arg.name, /^[a-z][a-z0-9]*$/, entry.name + ' arg name ' + arg.name);
            assert.ok(ARG_TYPES.includes(arg.type), entry.name + '.' + arg.name + ' type');
            assert.equal(typeof arg.required, 'boolean', entry.name + '.' + arg.name + ' required');
            assert.equal(typeof arg.description, 'string', entry.name + '.' + arg.name + ' description');
            assert.ok(arg.description.length > 0, entry.name + '.' + arg.name + ' description');
            if (arg.cli != null) { assert.match(arg.cli, /^[a-z][a-z0-9]*$/, entry.name + '.' + arg.name + ' cli flag'); }
        }
    }
});

test('every catalogue command is generated from its entry or an enumerated exception', () => {
    for (const entry of catalogue.commands) {
        if (entry.protocol == null) {
            assert.equal(entry.omitted, true, entry.name + ' without a protocol must be marked omitted');
            continue;
        }
        const generated = cliDispatch.isGenerated(entry);
        const exception = cliDispatch.CLI_EXCEPTIONS[entry.name];
        assert.ok(generated || (exception != null), entry.name + ' is neither generated nor an enumerated CLI exception');
        assert.equal(generated && (exception != null), false, entry.name + ' cannot be generated and an exception');
    }
});

test('the exception list holds real commands, each with a reason, and no generated command', () => {
    for (const name of Object.keys(cliDispatch.CLI_EXCEPTIONS)) {
        const entry = catalogue.byName(name);
        assert.ok(entry != null, name + ' names a catalogue command');
        assert.equal(cliDispatch.isGenerated(entry), false, name + ' is not generated');
        assert.ok(cliDispatch.CLI_EXCEPTIONS[name].length > 20, name + ' has a documented reason');
    }
});

test('every generated command declares a CLI formatter', () => {
    for (const entry of cliDispatch.generatedCommands()) {
        assert.equal(typeof entry.cli.format, 'function', entry.name + ' cli.format');
    }
});

test('MCP tool names are unique across the catalogue', () => {
    const names = catalogue.mcpCommands().map((entry) => entry.mcp.name);
    assert.equal(new Set(names).size, names.length);
});

test('byName finds declared commands and nothing else', () => {
    assert.equal(catalogue.byName('listdevices').name, 'listdevices');
    assert.equal(catalogue.byName('notacommand'), null);
});
