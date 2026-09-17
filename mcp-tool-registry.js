'use strict';

/**
* @description Declarative tool registry for the MeshCentral MCP bridge.
*
* Each MCP tool is declared once as an entry carrying a name, a description,
* an input schema and a handler. The registry validates a call's arguments
* against the declared schema, runs the handler and turns its result or error
* into an MCP CallToolResult. It knows nothing about transports, JSON-RPC or
* stdio; a tool handler knows nothing about them either. Every call produces
* exactly one audit record through the optional onInvocation hook.
*
* Entry shape:
*   name         Unique tool name, lower case with underscores (e.g. mesh_list_devices).
*   description  Human and agent readable description shown by tools/list.
*   inputSchema  Either a Zod object schema, or a non-empty raw shape of Zod
*                schemas (the shape the MCP SDK consumes directly). A raw shape
*                must not be empty: use z.object({}) for a tool with no
*                arguments.
*   target       Optional function (args) => string used for the audit record's
*                target. Its failures never fail the call.
*   handler      async (args) => CallToolResult. Arguments are the parsed and
*                validated arguments; the result is either the content shape
*                ({ content: [...] }) or that shape with isError: true.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { z } = require('zod');

/** A tool entry was declared incorrectly. */
class ToolRegistrationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolRegistrationError';
    }
}

function isZodSchema(value) {
    return (value != null) && (typeof value === 'object') && ((value._zod != null) || (value._def != null));
}

/** Build the text-only MCP result shape used by simple tools. */
function textResult(text) {
    return { content: [{ type: 'text', text: String(text) }] };
}

/** Build the text-only MCP error shape used for denials and failures. */
function errorResult(text) {
    const result = textResult(text);
    result.isError = true;
    return result;
}

/** Build an MCP result carrying one base64 image block and optional text. */
function imageResult(data, mimeType, text) {
    if ((data == null) || (mimeType == null)) {
        throw new TypeError('imageResult requires image data and a mime type.');
    }
    const image = { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: String(mimeType) };
    return { content: (text == null) ? [image] : [image, { type: 'text', text: String(text) }] };
}

function firstText(result) {
    if ((result != null) && Array.isArray(result.content)) {
        for (const block of result.content) {
            if ((block != null) && (block.type === 'text')) { return String(block.text); }
        }
    }
    return 'Tool failed.';
}

function validationMessage(toolName, error) {
    const issues = ((error != null) && Array.isArray(error.issues)) ? error.issues : null;
    if ((issues != null) && (issues.length > 0)) {
        const details = issues.map((issue) => {
            const path = (Array.isArray(issue.path) && (issue.path.length > 0)) ? (issue.path.join('.') + ': ') : '';
            return path + issue.message;
        }).join('; ');
        return 'Invalid arguments for ' + toolName + ': ' + details;
    }
    return 'Invalid arguments for ' + toolName + ': ' + ((error != null && error.message != null) ? error.message : String(error));
}

function toZodObject(inputSchema) {
    return isZodSchema(inputSchema) ? inputSchema : z.object(inputSchema);
}

/**
* A registry of declaratively declared tools.
*
* Options:
*   onInvocation(record)  Called once per call() with
*                         { tool, target, outcome, duration, reason }, where
*                         outcome is 'ok', 'denied' or 'error'. Failures in the
*                         hook are swallowed.
*   now()                 Clock in milliseconds, Date.now by default.
*/
class ToolRegistry {
    constructor(options) {
        options = options || {};
        this._tools = new Map();
        this._onInvocation = (typeof options.onInvocation === 'function') ? options.onInvocation : null;
        this._now = (typeof options.now === 'function') ? options.now : () => Date.now();
    }

    /** Declare a tool. Throws ToolRegistrationError on a malformed or duplicate entry. */
    register(tool) {
        if ((tool == null) || (typeof tool !== 'object')) {
            throw new ToolRegistrationError('A tool entry must be an object.');
        }
        if ((typeof tool.name !== 'string') || !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
            throw new ToolRegistrationError('Tool name must be a lower-case identifier with underscores.');
        }
        if ((typeof tool.description !== 'string') || (tool.description.length === 0)) {
            throw new ToolRegistrationError('Tool "' + tool.name + '" must have a description.');
        }
        if (tool.inputSchema == null) {
            throw new ToolRegistrationError('Tool "' + tool.name + '" must declare an inputSchema.');
        }
        if (!isZodSchema(tool.inputSchema)) {
            const keys = (typeof tool.inputSchema === 'object') ? Object.keys(tool.inputSchema) : [];
            if ((keys.length === 0) || !keys.every((key) => isZodSchema(tool.inputSchema[key]))) {
                throw new ToolRegistrationError('Tool "' + tool.name + '" inputSchema must be a Zod object schema or a raw shape with at least one property (use z.object({}) for no arguments).');
            }
        }
        if (typeof tool.handler !== 'function') {
            throw new ToolRegistrationError('Tool "' + tool.name + '" must have a handler function.');
        }
        if ((tool.target != null) && (typeof tool.target !== 'function')) {
            throw new ToolRegistrationError('Tool "' + tool.name + '" target must be a function.');
        }
        if (this._tools.has(tool.name)) {
            throw new ToolRegistrationError('Tool "' + tool.name + '" is already registered.');
        }
        this._tools.set(tool.name, tool);
        return tool;
    }

    /** Look up a declared tool entry, handler included. */
    get(name) {
        return this._tools.get(name) || null;
    }

    /** True when a tool with this name is declared. */
    has(name) {
        return this._tools.has(name);
    }

    /** The public declarations shown by tools/list, without handlers. */
    list() {
        return Array.from(this._tools.values()).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
        }));
    }

    /**
    * Validate arguments, run the tool and audit the invocation. Returns a
    * CallToolResult; never throws for tool or handler failures.
    */
    async call(name, args) {
        const started = this._now();
        const tool = this._tools.get(name);
        if (tool == null) {
            const reason = 'Unknown tool "' + name + '".';
            this._audit({ tool: name, target: null, outcome: 'denied', duration: this._now() - started, reason: reason });
            return errorResult(reason);
        }

        let parsed = null;
        try {
            parsed = toZodObject(tool.inputSchema).parse(args == null ? {} : args);
        } catch (error) {
            const reason = validationMessage(name, error);
            this._audit({ tool: name, target: null, outcome: 'denied', duration: this._now() - started, reason: reason });
            return errorResult(reason);
        }

        let target = null;
        if (tool.target != null) {
            try { target = tool.target(parsed); } catch (error) { target = null; }
        }

        try {
            const result = await tool.handler(parsed);
            const failed = (result != null) && (result.isError === true);
            this._audit({
                tool: name,
                target: target,
                outcome: failed ? 'error' : 'ok',
                duration: this._now() - started,
                reason: failed ? firstText(result) : null
            });
            return result;
        } catch (error) {
            const reason = ((error != null) && (error.message != null)) ? String(error.message) : String(error);
            this._audit({ tool: name, target: target, outcome: 'error', duration: this._now() - started, reason: reason });
            return errorResult(reason);
        }
    }

    _audit(record) {
        if (this._onInvocation == null) { return; }
        try { this._onInvocation(record); } catch (error) { }
    }
}

function createToolRegistry(options) {
    return new ToolRegistry(options);
}

module.exports = {
    ToolRegistry: ToolRegistry,
    ToolRegistrationError: ToolRegistrationError,
    createToolRegistry: createToolRegistry,
    textResult: textResult,
    errorResult: errorResult,
    imageResult: imageResult
};
