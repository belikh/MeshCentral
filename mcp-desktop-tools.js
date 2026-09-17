'use strict';

/**
* @description MeshCentral desktop tools for the MCP bridge.
*
* The snapshot tool launches a desktop relay session through the injected
* MeshCentral client, builds a DesktopCapture viewer from the session's
* captureConfig, waits for a frame and returns it as an MCP image content
* block with a text metadata block. The relay session is released on every
* path, success and failure alike. Handlers hold no protocol knowledge; server
* denials are surfaced verbatim.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { z } = require('zod');
const { DesktopCapture, IMAGE_TYPES } = require('./desktopcapture.js');
const { imageResult } = require('./mcp-tool-registry.js');

const IMAGE_TYPE_NAMES = ['jpeg', 'png', 'tiff', 'webp'];

/** Render the frame metadata that accompanies the image block. */
function formatFrameMetadata(frame) {
    const resolution = ((frame.width != null) && (frame.height != null)) ? (frame.width + 'x' + frame.height) : 'unknown resolution';
    const format = (frame.mimeType != null) ? frame.mimeType : 'unknown format';
    const frameIndex = (frame.index != null) ? frame.index : 'unknown';
    const timestamp = (frame.timestamp != null) ? new Date(frame.timestamp).toISOString() : 'unknown time';
    return 'resolution ' + resolution + ', format ' + format + ', frame ' + frameIndex + ', captured ' + timestamp;
}

// When the relay reported a denial before closing, prefer its own words over
// the generic transport message the viewer synthesised around them.
function surfaceCaptureError(error) {
    if ((error != null) && (typeof error.serverMessage === 'string') && (error.serverMessage.length > 0)) {
        return new Error(error.serverMessage);
    }
    return error;
}

/**
* Capture one frame from a device's screen.
*
* args.deviceid   Device id, bare or a full node id.
* args.imageType  Optional image encoding name (jpeg, png, tiff or webp).
* args.quality    Optional compression level 0-100.
* args.scale      Optional maximum frame width in pixels.
*
* createCapture is a factory (config) => DesktopCapture-compatible viewer.
*/
async function desktopSnapshot(client, args, createCapture) {
    const sessionOptions = {};
    if (args.imageType !== undefined) { sessionOptions.imageType = IMAGE_TYPES[args.imageType]; }
    if (args.quality !== undefined) { sessionOptions.compression = args.quality; }
    if (args.scale !== undefined) { sessionOptions.scaling = args.scale; }

    const session = await client.launchDesktopSession(args.deviceid, sessionOptions);
    try {
        const capture = session.attach(createCapture(session.captureConfig));
        let frame = null;
        try {
            await capture.start();
            frame = await capture.waitForFrame({ latest: true });
        } catch (error) {
            throw surfaceCaptureError(error);
        }
        return imageResult(frame.data, frame.mimeType, formatFrameMetadata(frame));
    } finally {
        try { await session.release(); } catch (error) { }
    }
}

/**
* Declare the MeshCentral desktop tools on a registry.
*
* options.client        A connected MeshCentralClient (or a compatible object).
* options.createCapture Optional capture factory, defaults to building a real
*                       DesktopCapture from the session captureConfig.
*/
function registerDesktopTools(registry, options) {
    options = options || {};
    if (options.client == null) { throw new Error('registerDesktopTools requires a client.'); }
    const createCapture = (typeof options.createCapture === 'function')
        ? options.createCapture
        : (config) => new DesktopCapture(config);

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
        handler: (args) => desktopSnapshot(options.client, args, createCapture)
    });

    return registry;
}

module.exports = {
    registerDesktopTools: registerDesktopTools,
    desktopSnapshot: desktopSnapshot,
    formatFrameMetadata: formatFrameMetadata
};
