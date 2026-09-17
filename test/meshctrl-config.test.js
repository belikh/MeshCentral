'use strict';

/**
 * meshctrl's offline config domain editing. The config command reads and
 * writes config.json in the current directory, so each test runs the CLI as a
 * subprocess against a temporary file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MESHCTRL = path.join(__dirname, '..', 'meshctrl.js');

function runConfig(dir, args) {
    return spawnSync(process.execPath, [MESHCTRL, 'config'].concat(args), { cwd: dir, encoding: 'utf8' });
}

function readConfig(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}

test('meshctrl sets and removes the domain agentAllowedIPNewAgents value', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-config-'));
    try {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ domains: { testdomain: {} } }, null, 2));

        let result = runConfig(dir, ['--settodomain', 'testdomain', '--agentAllowedIPNewAgents', '10.0.0.0/8']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readConfig(dir).domains.testdomain.agentAllowedIPNewAgents, '10.0.0.0/8');

        result = runConfig(dir, ['--removefromdomain', 'testdomain', '--agentAllowedIPNewAgents']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readConfig(dir).domains.testdomain.agentAllowedIPNewAgents, undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
