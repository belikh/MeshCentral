'use strict';

/**
 * Tests for the declarative MCP tool registry.
 *
 * The registry is protocol-free: tools declare a name, description, input
 * schema and handler, and every call is validated and audited. These tests
 * use no MCP SDK client and no live server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const { createToolRegistry, ToolRegistrationError } = require('../mcp-tool-registry.js');

function sequentialClock(values) {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
}

function demoEntry(overrides) {
    return Object.assign({
        name: 'mesh_demo',
        description: 'A demonstration tool.',
        inputSchema: { id: z.string() },
        handler: async () => ({ content: [{ type: 'text', text: 'done' }] })
    }, overrides || {});
}

test('register rejects entries that are missing required fields', () => {
    for (const key of ['name', 'description', 'inputSchema', 'handler']) {
        const registry = createToolRegistry();
        const entry = demoEntry();
        delete entry[key];
        assert.throws(() => registry.register(entry), ToolRegistrationError, 'missing ' + key);
    }
    assert.throws(() => createToolRegistry().register(null), ToolRegistrationError);
    assert.throws(() => createToolRegistry().register('mesh_demo'), ToolRegistrationError);
});

test('register rejects malformed fields', () => {
    assert.throws(() => createToolRegistry().register(demoEntry({ name: 'Mesh Demo' })), ToolRegistrationError);
    assert.throws(() => createToolRegistry().register(demoEntry({ name: '' })), ToolRegistrationError);
    assert.throws(() => createToolRegistry().register(demoEntry({ description: '' })), ToolRegistrationError);
    assert.throws(() => createToolRegistry().register(demoEntry({ handler: 'not a function' })), ToolRegistrationError);
    assert.throws(() => createToolRegistry().register(demoEntry({ target: 'not a function' })), ToolRegistrationError);
});

test('register rejects an empty input schema', () => {
    const registry = createToolRegistry();
    assert.throws(() => registry.register(demoEntry({ inputSchema: {} })), (err) => {
        assert.ok(err instanceof ToolRegistrationError);
        assert.match(err.message, /at least one property/);
        return true;
    });
});

test('register rejects duplicate tool names and accepts z.object schemas', () => {
    const registry = createToolRegistry();
    registry.register(demoEntry({ inputSchema: z.object({ id: z.string() }) }));
    assert.throws(() => registry.register(demoEntry({ inputSchema: z.object({ id: z.string() }) })), ToolRegistrationError);
});

test('list exposes declarations without handlers', () => {
    const registry = createToolRegistry();
    const schema = { id: z.string() };
    const entry = demoEntry({ inputSchema: schema });
    registry.register(entry);
    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'mesh_demo');
    assert.equal(list[0].description, 'A demonstration tool.');
    assert.equal(list[0].inputSchema, schema);
    assert.equal('handler' in list[0], false);
    assert.equal(registry.has('mesh_demo'), true);
    assert.equal(registry.get('mesh_demo'), entry);
    assert.equal(registry.get('mesh_missing'), null);
});

test('call parses arguments, runs the handler and audits an ok invocation', async () => {
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record), now: sequentialClock([100, 142]) });
    let received = null;
    registry.register(demoEntry({
        inputSchema: { meshid: z.string().optional() },
        target: (args) => ((args.meshid != null) ? args.meshid : 'all'),
        handler: async (args) => { received = args; return { content: [{ type: 'text', text: 'devices' }] }; }
    }));

    const result = await registry.call('mesh_demo', { meshid: 'mesh//abc', unknown: 'stripped' });

    assert.deepEqual(received, { meshid: 'mesh//abc' });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'devices' }] });
    assert.deepEqual(records, [
        { tool: 'mesh_demo', target: 'mesh//abc', outcome: 'ok', duration: 42, reason: null }
    ]);
});

test('call validates arguments and audits a denial without running the handler', async () => {
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record), now: () => 7 });
    let called = false;
    registry.register(demoEntry({
        handler: async () => { called = true; return { content: [] }; }
    }));

    const result = await registry.call('mesh_demo', { id: 42 });

    assert.equal(called, false);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Invalid arguments for mesh_demo:/);
    assert.match(result.content[0].text, /id/);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'denied');
    assert.equal(records[0].target, null);
    assert.equal(records[0].duration, 0);
    assert.equal(records[0].reason, result.content[0].text);
});

test('call treats missing arguments as an empty invocation', async () => {
    const registry = createToolRegistry();
    registry.register(demoEntry({ inputSchema: { id: z.string().optional() } }));
    const result = await registry.call('mesh_demo');
    assert.deepEqual(result, { content: [{ type: 'text', text: 'done' }] });
});

test('call converts a thrown error into an error result and audits it', async () => {
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record), now: sequentialClock([10, 35]) });
    registry.register(demoEntry({
        handler: async () => { throw new Error('Access denied: no rights to this device group'); }
    }));

    const result = await registry.call('mesh_demo', { id: 'node//x' });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Access denied: no rights to this device group' }], isError: true });
    assert.deepEqual(records[0], {
        tool: 'mesh_demo',
        target: null,
        outcome: 'error',
        duration: 25,
        reason: 'Access denied: no rights to this device group'
    });
});

test('call audits a handler isError result with its text as the reason', async () => {
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record), now: () => 1 });
    registry.register(demoEntry({
        handler: async () => ({ content: [{ type: 'text', text: 'Device is offline.' }], isError: true })
    }));

    const result = await registry.call('mesh_demo', { id: 'node//x' });

    assert.equal(result.isError, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].reason, 'Device is offline.');
});

test('call of an unknown tool returns a denial and audits it', async () => {
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record), now: () => 0 });
    const result = await registry.call('mesh_missing', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool "mesh_missing"/);
    assert.deepEqual(records, [
        { tool: 'mesh_missing', target: null, outcome: 'denied', duration: 0, reason: 'Unknown tool "mesh_missing".' }
    ]);
});

test('a throwing target function does not fail the call', async () => {
    const records = [];
    const registry = createToolRegistry({ onInvocation: (record) => records.push(record), now: () => 0 });
    registry.register(demoEntry({ target: () => { throw new Error('bad target'); } }));
    const result = await registry.call('mesh_demo', { id: 'node//x' });
    assert.equal(result.isError, undefined);
    assert.equal(records[0].target, null);
    assert.equal(records[0].outcome, 'ok');
});

test('a throwing audit sink does not fail the call', async () => {
    const registry = createToolRegistry({ onInvocation: () => { throw new Error('audit sink exploded'); }, now: () => 0 });
    registry.register(demoEntry());
    const result = await registry.call('mesh_demo', { id: 'node//x' });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'done' }] });
});
