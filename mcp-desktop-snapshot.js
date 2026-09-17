'use strict';

/**
 * @description The mesh_desktop_snapshot MCP tool.
 *
 * The snapshot tool launches a desktop relay session through the injected
 * MeshCentral client, builds a DesktopCapture viewer from the session's
 * captureConfig, waits for a frame and returns it as an MCP image content
 * block with a text metadata block. The relay session is released on every
 * path, success and failure alike.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { z } = require('zod');
const { imageResult } = require('./mcp-tool-registry.js');
const { startSessionCapture, releaseSession } = require('./desktop-capture-session.js');
const { IMAGE_TYPE_NAMES, formatFrameMetadata, sessionOptionsFrom, surfaceCaptureError } = require('./mcp-desktop-shared.js');

/**
 * Capture one frame from a device's screen.
 *
 * args.deviceid   Device id, bare or a full node id.
 * args.imageType  Optional image encoding name (jpeg, png, tiff or webp).
 * args.quality    Optional compression level 0-100.
 * args.scale      Optional maximum frame width in pixels.
 *
 * createCapture is a factory (config) => DesktopCapture-compatible viewer.
 * defaults, when given, are the configured fallbacks for imageType, quality and
 * scale; explicit arguments win over them.
 */
async function desktopSnapshot(client, args, createCapture, defaults) {
    const session = await client.launchDesktopSession(args.deviceid, sessionOptionsFrom(args, defaults));
    try {
        let frame = null;
        try {
            const capture = await startSessionCapture(session, createCapture);
            frame = await capture.waitForFrame({ latest: true });
        } catch (error) {
            throw surfaceCaptureError(error);
        }
        return imageResult(frame.data, frame.mimeType, formatFrameMetadata(frame));
    } finally {
        await releaseSession(session);
    }
}

/**
 * Declare the snapshot tool on a registry.
 *
 * options.client         A connected MeshCentralClient (or a compatible object).
 * options.createCapture  Capture factory, (config) => viewer.
 * options.defaults       Configured image defaults for sessionOptionsFrom.
 */
function registerSnapshotTool(registry, options) {
    registry.register({
        name: 'mesh_desktop_snapshot',
        description: 'Capture the current screen of a device as an image and return it with its resolution, format and timestamp. Opens a desktop relay session for the device, captures one frame and closes the session. The device id may be a bare id or a full node id (node//...). Optional imageType (jpeg, png, tiff or webp), quality (compression 0-100) and scale (maximum frame width in pixels) control the frame; the capture module defaults apply otherwise. The account\'s desktop right and the server\'s consent, privacy and recording behaviour are unchanged.',
        inputSchema: {
            deviceid: z.string().min(1).describe('Device id of the machine to capture, bare or a full node id (node//...).'),
            imageType: z.enum(IMAGE_TYPE_NAMES).optional().describe('Image encoding: jpeg (default), png, tiff or webp.'),
            quality: z.number().int().min(0).max(100).optional().describe('Image compression level 0 to 100; the capture module default is 50.'),
            scale: z.number().int().min(1).max(65535).optional().describe('Maximum frame width in pixels; the capture module default is 1024.')
        },
        target: (args) => args.deviceid,
        handler: (args) => desktopSnapshot(options.client, args, options.createCapture, options.defaults)
    });
}

module.exports = {
    registerSnapshotTool: registerSnapshotTool,
    desktopSnapshot: desktopSnapshot
};
