'use strict';

/**
 * Tests for the Linux SMBIOS canonicalisation of `dmidecode -u` output.
 *
 * The two fixtures are sanitised, synthetic dumps of the same SMBIOS records:
 * dmidecode 3.x prints the decoded string lines unquoted, dmidecode 2.x quoted
 * them. A decoded string that is itself valid hex ("008689", "20", "0807") must
 * not be read as a hex dump: doing so corrupts the structures that follow and
 * hides the Intel AMT OEM records (types 130/131), so the agent never starts
 * the AMT module. No real machine data is used.
 *
 * The agent module loads its bundled MemoryStream lazily, which does not exist
 * outside the agent runtime, so the tests pass their own sink through the
 * optional second argument of _canonicalizeData. No other seam is added.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, 'fixtures');

let smbios = null;
try { smbios = require('../agents/modules_meshcore/smbios.js'); } catch (error) { smbios = null; }

class MemoryStreamStub {
    constructor() {
        this.chunks = [];
    }

    write(chunk) {
        this.chunks.push(Buffer.from(chunk));
    }

    get buffer() {
        return Buffer.concat(this.chunks);
    }
}

const MODULE_SKIP = smbios ? false : 'the agent smbios module is not loadable outside the agent runtime';
const DMIDECODE_SKIP = MODULE_SKIP || (process.platform === 'linux' ? false : 'dmidecode canonicalisation only runs on Linux');

function fixture(name) {
    return Buffer.from(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function canonicalize(name) {
    return smbios._canonicalizeData(fixture(name), MemoryStreamStub);
}

function parseFixture(name) {
    return smbios._parse(canonicalize(name));
}

test('dmidecode 3.x keeps the structures after hex-looking decoded strings', { skip: DMIDECODE_SKIP }, () => {
    const parsed = parseFixture('dmidecode-3x.txt');

    assert.deepEqual(Object.keys(parsed).sort(), ['1', '130', '131', '39']);
    assert.equal(parsed[134], undefined);
    assert.equal(parsed[130][0].slice(0, 4).toString(), '$AMT');
    assert.equal(parsed[131][0].slice(52, 56).toString(), 'vPro');
});

test('dmidecode 3.x decoded lines never become string bytes', { skip: DMIDECODE_SKIP }, () => {
    const parsed = parseFixture('dmidecode-3x.txt');

    // _strings keeps the NUL terminator that the parser walks over today.
    assert.deepEqual(parsed[1][0]._strings, ['Example Inc.\u0000', 'Example Board\u0000', '1.0\u0000', '008689\u0000', '20\u0000', '0807\u0000']);
    assert.deepEqual(parsed[39][0]._strings, ['20\u0000', '008689\u0000', 'Example PS\u0000', '0807\u0000']);
});

test('dmidecode 2.x quoted output canonicalises identically to 3.x', { skip: DMIDECODE_SKIP }, () => {
    assert.ok(canonicalize('dmidecode-2x.txt').equals(canonicalize('dmidecode-3x.txt')));
});

test('dmidecode 2.x quoted output still parses strings and AMT records', { skip: DMIDECODE_SKIP }, () => {
    const parsed = parseFixture('dmidecode-2x.txt');

    assert.deepEqual(Object.keys(parsed).sort(), ['1', '130', '131', '39']);
    assert.deepEqual(parsed[39][0]._strings, ['20\u0000', '008689\u0000', 'Example PS\u0000', '0807\u0000']);

    const info = smbios.parse(parseFixture('dmidecode-2x.txt'));
    assert.equal(info.amtInfo.AMT, true);
    assert.equal(info.amtInfo.ManagementEngine, '8.55.9.10');
});

test('the fixture parses its full AMT settings through parse()', { skip: DMIDECODE_SKIP }, () => {
    const info = smbios.parse(parseFixture('dmidecode-3x.txt'));

    assert.deepEqual(info.systemInfo, {
        _ObjectID: 'SMBiosTables.systemInfo',
        uuid: '00000000-0000-0000-0000-000000000000',
        wakeReason: 'Power Switch'
    });
    assert.deepEqual(info.amtInfo, {
        AMT: true,
        enabled: true,
        storageRedirection: true,
        serialOverLan: true,
        kvm: true,
        TXT: true,
        VMX: true,
        MEBX: '1.2.3.4',
        ManagementEngine: '8.55.9.10'
    });
});

test('amtInfo returns {AMT:false} when no OEM AMT records exist', { skip: MODULE_SKIP }, () => {
    assert.deepEqual(smbios.amtInfo({}), { AMT: false });
});

test('amtInfo tolerates a board without the vPro record', { skip: DMIDECODE_SKIP }, () => {
    const parsed = parseFixture('dmidecode-3x.txt');

    let info;
    assert.doesNotThrow(() => { info = smbios.amtInfo({ 130: parsed[130] }); });
    assert.equal(info.AMT, true);
    assert.equal(info.enabled, true);
    assert.equal(info.TXT, undefined);
    assert.equal(info.ManagementEngine, undefined);
});

test('a board without a type 131 record still yields an AMT verdict for the module startup', { skip: DMIDECODE_SKIP }, () => {
    const parsed = parseFixture('dmidecode-3x.txt');

    // meshcore starts the AMT module on this verdict (agents/meshcore.js:954).
    const info = smbios.parse({ 130: parsed[130] });
    assert.equal(info.amtInfo && info.amtInfo.AMT, true);
});

test('amtInfo falls back to the vPro record when $AMT is absent', { skip: DMIDECODE_SKIP }, () => {
    const parsed = parseFixture('dmidecode-3x.txt');

    assert.deepEqual(smbios.amtInfo({ 131: parsed[131] }), { AMT: true });
});

test('amtInfo ignores a type 131 record without the vPro marker', { skip: DMIDECODE_SKIP }, () => {
    const parsed = parseFixture('dmidecode-3x.txt');
    const noVpro = Buffer.from(parsed[131][0]);
    noVpro.write('none', 52, 'latin1');

    assert.deepEqual(smbios.amtInfo({ 131: [noVpro] }), { AMT: false });
});
