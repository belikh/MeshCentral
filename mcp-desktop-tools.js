'use strict';

/**
 * @description MeshCentral desktop tools for the MCP bridge.
 *
 * The tools are split by family: mcp-desktop-snapshot.js captures one frame,
 * mcp-desktop-frames.js serves sequences and polls through the session cache,
 * mcp-desktop-input.js applies mouse, keyboard and text actions, and
 * mcp-desktop-status.js reports capture feasibility without a session. The
 * argument, metadata and error helpers they share live in
 * mcp-desktop-shared.js, and the attach/start/release shape lives in
 * desktop-capture-session.js. This module composes the four families into one
 * registerDesktopTools call and re-exports the public surface.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { DesktopCapture } = require('./desktopcapture.js');
const { createDesktopSessionCache } = require('./desktop-session-cache.js');
const { registerSnapshotTool, desktopSnapshot } = require('./mcp-desktop-snapshot.js');
const { registerFramesTool, desktopFrames, captureSequence } = require('./mcp-desktop-frames.js');
const { registerInputTool, desktopInput, applyDesktopActions, desktopActionSchema } = require('./mcp-desktop-input.js');
const { registerStatusTool, desktopStatus, resolveDesktopRight } = require('./mcp-desktop-status.js');
const { sessionOptionsFrom, formatFrameMetadata } = require('./mcp-desktop-shared.js');

/**
 * Declare the MeshCentral desktop tools on a registry.
 *
 * options.client          A connected MeshCentralClient (or a compatible object).
 * options.createCapture   Optional capture factory, defaults to building a real
 *                         DesktopCapture from the session captureConfig.
 * options.cache           Optional DesktopSessionCache shared by the frames
 *                         and input tools; defaults to a cache over
 *                         options.client whose sessions close after idling and
 *                         on process exit.
 * options.acquireCapture  Optional function (deviceid) => capture|null. When it
 *                         returns a capture, mesh_desktop_input reuses that
 *                         started capture instead of acquiring from the cache.
 * options.defaults        Optional { imageType, quality, scale } applied when a
 *                         session is opened without the matching call argument;
 *                         explicit arguments win, capture module defaults apply
 *                         when neither is set.
 * options.now             Clock in milliseconds for the status tool's cached
 *                         session age; Date.now by default.
 * options.idleTimeout     Idle timeout for the default cache, in milliseconds.
 * options.lifecycle       Process-like emitter carrying 'exit' for the default
 *                         cache; defaults to process.
 */
function registerDesktopTools(registry, options) {
    options = options || {};
    if (options.client == null) { throw new Error('registerDesktopTools requires a client.'); }
    const defaults = options.defaults || {};
    const createCapture = (typeof options.createCapture === 'function')
        ? options.createCapture
        : (config) => new DesktopCapture(config);
    const cache = (options.cache != null) ? options.cache : createDesktopSessionCache({
        client: options.client,
        createCapture: createCapture,
        idleTimeout: options.idleTimeout,
        lifecycle: options.lifecycle
    });
    const acquireCapture = (typeof options.acquireCapture === 'function') ? options.acquireCapture : null;

    registerSnapshotTool(registry, { client: options.client, createCapture: createCapture, defaults: defaults });
    registerFramesTool(registry, { cache: cache, defaults: defaults });
    registerInputTool(registry, {
        client: options.client,
        createCapture: createCapture,
        cache: cache,
        acquireCapture: acquireCapture,
        defaults: defaults
    });
    registerStatusTool(registry, { client: options.client, cache: cache, now: options.now });

    return registry;
}

module.exports = {
    registerDesktopTools: registerDesktopTools,
    desktopStatus: desktopStatus,
    resolveDesktopRight: resolveDesktopRight,
    desktopSnapshot: desktopSnapshot,
    desktopFrames: desktopFrames,
    sessionOptionsFrom: sessionOptionsFrom,
    captureSequence: captureSequence,
    desktopInput: desktopInput,
    applyDesktopActions: applyDesktopActions,
    formatFrameMetadata: formatFrameMetadata,
    desktopActionSchema: desktopActionSchema
};
