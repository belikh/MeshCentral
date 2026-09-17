'use strict';

/**
 * @description The mesh_desktop_frames MCP tool.
 *
 * The frames tool serves both a bounded sequence (up to count frames on a
 * minimum interval, bounded by a total timeout) and a cheap poll of the latest
 * frame. Both reuse a short-lived session cache keyed by device id, so poll and
 * look-act-look loops do not renegotiate the relay per call; a failure evicts
 * the cached session instead of leaving a stale entry behind. The handlers
 * hold no protocol knowledge; server denials are surfaced verbatim.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { z } = require('zod');
const { DesktopCaptureError } = require('./desktopcapture.js');
const { imageResult } = require('./mcp-tool-registry.js');
const { IMAGE_TYPE_NAMES, formatFrameMetadata, sessionOptionsFrom, surfaceCaptureError } = require('./mcp-desktop-shared.js');

const DEFAULT_FRAME_COUNT = 3;
const MAX_FRAME_COUNT = 10;
const DEFAULT_FRAME_INTERVAL = 500;
const MIN_FRAME_INTERVAL = 1;
const MAX_FRAME_INTERVAL = 60000;
const DEFAULT_FRAMES_TIMEOUT = 30000;
const MIN_FRAMES_TIMEOUT = 1;
const MAX_FRAMES_TIMEOUT = 300000;

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Collect up to options.count frames from a live capture, waiting at least
 * options.interval milliseconds between captures and never running past
 * options.timeout. Returns the frames captured inside the budget; throws when
 * not one frame arrived.
 */
async function captureSequence(capture, options) {
    const now = (typeof options.now === 'function') ? options.now : Date.now;
    const sleep = (typeof options.sleep === 'function') ? options.sleep : delay;
    const deadline = now() + options.timeout;
    const frames = [];
    let lastCaptured = 0;
    for (let index = 0; index < options.count; index++) {
        if (index > 0) {
            const budget = deadline - now();
            if (budget <= 0) { break; }
            const pause = Math.min(options.interval - (now() - lastCaptured), budget);
            if (pause > 0) { await sleep(pause); }
        }
        const budget = deadline - now();
        if (budget <= 0) { break; }
        frames.push(await capture.waitForFrame({ latest: true, timeout: budget }));
        lastCaptured = now();
    }
    if (frames.length === 0) {
        throw new DesktopCaptureError('Timed out waiting for a desktop frame', 'E_TIMEOUT');
    }
    return frames;
}

/** Shape a sequence as image/text block pairs, one pair per frame. */
function framesResult(frames) {
    const content = [];
    for (const frame of frames) {
        const result = imageResult(frame.data, frame.mimeType, formatFrameMetadata(frame));
        for (const block of result.content) { content.push(block); }
    }
    return { content: content };
}

/**
 * Capture frames from a device's screen through a cached desktop session.
 *
 * args.deviceid  Device id, bare or a full node id.
 * args.mode      'sequence' (default) or 'poll'.
 * args.count     Sequence frames, 1..MAX_FRAME_COUNT, default 3.
 * args.interval  Minimum milliseconds between sequence frames, default 500.
 * args.timeout   Total call budget in milliseconds, default 30000.
 *
 * The session is cached per device and stays open (closing when it idles out),
 * so repeated polls and look-act-look loops reuse one relay negotiation. Any
 * failure releases the cached session so the next call renegotiates.
 */
async function desktopFrames(cache, args, defaults, seams) {
    let entry = null;
    try {
        entry = await cache.acquire(args.deviceid, sessionOptionsFrom(args, defaults));
    } catch (error) {
        throw surfaceCaptureError(error);
    }
    try {
        if (args.mode === 'poll') {
            const frame = await entry.capture.waitForFrame({
                latest: true,
                timeout: (args.timeout != null) ? args.timeout : DEFAULT_FRAMES_TIMEOUT
            });
            return imageResult(frame.data, frame.mimeType, formatFrameMetadata(frame));
        }
        const frames = await captureSequence(entry.capture, Object.assign({
            count: (args.count != null) ? args.count : DEFAULT_FRAME_COUNT,
            interval: (args.interval != null) ? args.interval : DEFAULT_FRAME_INTERVAL,
            timeout: (args.timeout != null) ? args.timeout : DEFAULT_FRAMES_TIMEOUT
        }, seams || {}));
        return framesResult(frames);
    } catch (error) {
        try { await cache.release(args.deviceid, entry); } catch (ex) { }
        throw surfaceCaptureError(error);
    } finally {
        cache.finish(entry);
    }
}

/**
 * Declare the frames tool on a registry.
 *
 * options.cache     The DesktopSessionCache shared with the input tool.
 * options.defaults  Configured image defaults for sessionOptionsFrom.
 * options.now       Clock used by the sequence budget; Date.now by default.
 * options.sleep     Sleep used between sequence frames; a timer by default.
 */
function registerFramesTool(registry, options) {
    registry.register({
        name: 'mesh_desktop_frames',
        description: 'Capture a bounded sequence of the current screen of a device, or poll the latest frame. In sequence mode (the default) up to count frames are captured at least interval milliseconds apart and returned as image blocks, each with its index, timestamp and resolution in the accompanying text; the call stops at timeout and returns the frames captured so far. In poll mode the latest frame from a short-lived cached desktop session is returned, opening a session only when none is cached, so watch-until-done loops are cheap. Image options apply when a session is opened; a cached session keeps its encoding until it idles out. The device id may be a bare id or a full node id (node//...). The account\'s desktop right and the server\'s consent, privacy and recording behaviour are unchanged.',
        inputSchema: {
            deviceid: z.string().min(1).describe('Device id of the machine to capture, bare or a full node id (node//...).'),
            mode: z.enum(['sequence', 'poll']).optional().describe('sequence (default) captures up to count frames on an interval; poll returns the latest frame from the cached session.'),
            count: z.number().int().min(1).max(MAX_FRAME_COUNT).optional().describe('Sequence mode frames to capture, 1 to ' + MAX_FRAME_COUNT + '; the default is ' + DEFAULT_FRAME_COUNT + '.'),
            interval: z.number().int().min(MIN_FRAME_INTERVAL).max(MAX_FRAME_INTERVAL).optional().describe('Sequence mode minimum milliseconds between frames; the default is ' + DEFAULT_FRAME_INTERVAL + '.'),
            timeout: z.number().int().min(MIN_FRAMES_TIMEOUT).max(MAX_FRAMES_TIMEOUT).optional().describe('Total budget for the call in milliseconds; the default is ' + DEFAULT_FRAMES_TIMEOUT + '.'),
            imageType: z.enum(IMAGE_TYPE_NAMES).optional().describe('Image encoding for a newly opened session: jpeg (default), png, tiff or webp.'),
            quality: z.number().int().min(0).max(100).optional().describe('Image compression level 0 to 100 for a newly opened session; the capture module default is 50.'),
            scale: z.number().int().min(1).max(65535).optional().describe('Maximum frame width in pixels for a newly opened session; the capture module default is 1024.')
        },
        target: (args) => args.deviceid,
        handler: (args) => desktopFrames(options.cache, args, options.defaults, { now: options.now, sleep: options.sleep })
    });
}

module.exports = {
    registerFramesTool: registerFramesTool,
    desktopFrames: desktopFrames,
    captureSequence: captureSequence
};
