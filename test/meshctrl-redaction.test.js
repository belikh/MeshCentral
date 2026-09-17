'use strict';

/**
 * Tests that meshctrl output never exposes the login key or auth cookie
 * carried in the control url. meshctrl executes on require (it parses
 * process.argv and may exit), so it runs as a child process against a closed
 * port: no live MeshCentral server is required and no socket leaves the host.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MESHCTRL = path.join(__dirname, '..', 'meshctrl.js');

function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

test('a failed connection never prints the url login key or auth cookie', async () => {
    const port = await closedPort();
    const result = spawnSync(process.execPath, [
        MESHCTRL,
        'serverinfo',
        '--url', 'ws://127.0.0.1:' + port + '?key=SECRETLOGINKEY&auth=SECRETCOOKIE'
    ], { encoding: 'utf8', timeout: 5000 });

    assert.equal(result.error, undefined);
    const output = (result.stdout || '') + (result.stderr || '');
    assert.match(output, /Unable to connect to ws:\/\/127\.0\.0\.1:/);
    assert.doesNotMatch(output, /SECRETLOGINKEY|SECRETCOOKIE/);
    assert.doesNotMatch(output, /[?&](?:key|auth)=/i);
});
