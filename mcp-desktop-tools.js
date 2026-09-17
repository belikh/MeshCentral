'use strict';

/**
* @description MeshCentral desktop tools for the MCP bridge.
*
* The snapshot tool launches a desktop relay session through the injected
* MeshCentral client, builds a DesktopCapture viewer from the session's
* captureConfig, waits for a frame and returns it as an MCP image content
* block with a text metadata block. The relay session is released on every
* path, success and failure alike.
*
* The frames tool serves both a bounded sequence (up to count frames on a
* minimum interval, bounded by a total timeout) and a cheap poll of the latest
* frame. Both reuse a short-lived session cache keyed by device id, so poll and
* look-act-look loops do not renegotiate the relay per call; a failure evicts
* the cached session instead of leaving a stale entry behind. Handlers hold no
* protocol knowledge; server denials are surfaced verbatim.
*
* The input tool applies an ordered list of mouse, keyboard and text actions to
* a desktop session. It acquires the session cache entry for the call so an
* idle eviction cannot cut a long sequence short, and opens (and releases) a
* relay session only when no session is cached. Coordinates are in
* the pixel space of the latest frame from the same session and are scaled onto
* the remote screen using that frame's screen metadata. Together the tools form
* the look-act-look loop:
*
*   mesh_desktop_snapshot  - see the current screen
*   mesh_desktop_input     - move, click, scroll, press keys, type text
*   mesh_desktop_snapshot  - see the screen change
*
* The status tool reports whether a capture is currently possible for a device
* before any session is attempted: device online state, the agent's desktop
* capability, the account's desktop relay right and any cached session. It
* never launches a relay session: it reads the node record and the connection
* handshake, and peeks the session cache.
*
* @author Jupiter Belic
* @license Apache-2.0
*/

const { z } = require('zod');
const {
    DesktopCapture,
    DesktopCaptureError,
    IMAGE_TYPES,
    KEY_NAMES,
    encodeMouseMove,
    encodeMouseButton,
    encodeMouseScroll,
    encodeKey,
    encodeText,
    scaleCoordinates
} = require('./desktopcapture.js');
const { createDesktopSessionCache } = require('./desktop-session-cache.js');
const { imageResult, textResult } = require('./mcp-tool-registry.js');

const IMAGE_TYPE_NAMES = ['jpeg', 'png', 'tiff', 'webp'];
const MOUSE_BUTTON_NAMES = ['left', 'right', 'middle'];
const KEY_ACTION_NAMES = ['press', 'down', 'up'];
const MAX_ACTIONS = 200;
const MAX_TEXT_LENGTH = 1024;
const DEFAULT_STEP_DELAY = 5;
const DEFAULT_FRAME_TIMEOUT = 5000;

// The agent capability bit that advertises desktop capture support.
const AGENT_CAPS_DESKTOP = 1;
// Mesh rights that permit a desktop relay: remote control (8) or relay (0x200000).
const MESH_RIGHTS_DESKTOP = 0x00200008;
const SITE_RIGHTS_ADMIN = 0xFFFFFFFF;

const DEFAULT_FRAME_COUNT = 3;
const MAX_FRAME_COUNT = 10;
const DEFAULT_FRAME_INTERVAL = 500;
const MIN_FRAME_INTERVAL = 1;
const MAX_FRAME_INTERVAL = 60000;
const DEFAULT_FRAMES_TIMEOUT = 30000;
const MIN_FRAMES_TIMEOUT = 1;
const MAX_FRAMES_TIMEOUT = 300000;

/** Render the frame metadata that accompanies the image block. */
function formatFrameMetadata(frame) {
    const resolution = ((frame.width != null) && (frame.height != null)) ? (frame.width + 'x' + frame.height) : 'unknown resolution';
    const format = (frame.mimeType != null) ? frame.mimeType : 'unknown format';
    const frameIndex = (frame.index != null) ? frame.index : 'unknown';
    const timestamp = (frame.timestamp != null) ? new Date(frame.timestamp).toISOString() : 'unknown time';
    return 'resolution ' + resolution + ', format ' + format + ', frame ' + frameIndex + ', captured ' + timestamp;
}

// When the relay reported a denial before closing, prefer its own words over
// the generic transport message the viewer synthesised around them. Client
// errors (authentication, launch denials) keep their actionable messages.
function surfaceCaptureError(error) {
    if ((error instanceof DesktopCaptureError) && (typeof error.serverMessage === 'string') && (error.serverMessage.length > 0)) {
        return new Error(error.serverMessage);
    }
    return error;
}

// Translate the shared imageType/quality/scale arguments into session options.
// Explicit call arguments win over the bridge's configured defaults; without
// either, the option is left unset so the capture module's own defaults apply.
// The same options feed the snapshot launch, the input launch and the frames
// cache, so every session opened by these tools honours the defaults.
function sessionOptionsFrom(args, defaults) {
    defaults = defaults || {};
    const sessionOptions = {};
    const imageType = (args.imageType !== undefined) ? args.imageType : defaults.imageType;
    if (imageType !== undefined) { sessionOptions.imageType = IMAGE_TYPES[imageType]; }
    const quality = (args.quality !== undefined) ? args.quality : defaults.quality;
    if (quality !== undefined) { sessionOptions.compression = quality; }
    const scale = (args.scale !== undefined) ? args.scale : defaults.scale;
    if (scale !== undefined) { sessionOptions.scaling = scale; }
    return sessionOptions;
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
* defaults, when given, are the configured fallbacks for imageType, quality and
* scale; explicit arguments win over them.
*/
async function desktopSnapshot(client, args, createCapture, defaults) {
    const session = await client.launchDesktopSession(args.deviceid, sessionOptionsFrom(args, defaults));
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
    const deadline = Date.now() + options.timeout;
    const frames = [];
    let lastCaptured = 0;
    for (let index = 0; index < options.count; index++) {
        if (index > 0) {
            const budget = deadline - Date.now();
            if (budget <= 0) { break; }
            const pause = Math.min(options.interval - (Date.now() - lastCaptured), budget);
            if (pause > 0) { await delay(pause); }
        }
        const budget = deadline - Date.now();
        if (budget <= 0) { break; }
        frames.push(await capture.waitForFrame({ latest: true, timeout: budget }));
        lastCaptured = Date.now();
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
async function desktopFrames(cache, args, defaults) {
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
        const frames = await captureSequence(entry.capture, {
            count: (args.count != null) ? args.count : DEFAULT_FRAME_COUNT,
            interval: (args.interval != null) ? args.interval : DEFAULT_FRAME_INTERVAL,
            timeout: (args.timeout != null) ? args.timeout : DEFAULT_FRAMES_TIMEOUT
        });
        return framesResult(frames);
    } catch (error) {
        try { await cache.release(args.deviceid, entry); } catch (ex) { }
        throw surfaceCaptureError(error);
    } finally {
        cache.finish(entry);
    }
}
const coordinateSchema = z.number().int().min(0).max(65535);

// One action in the ordered list. Coordinates are in frame pixels: the space
// of the image mesh_desktop_snapshot returns. The handler scales them onto the
// remote screen with the frame's screen metadata before encoding.
const desktopActionSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('move'),
        x: coordinateSchema.describe('Pointer x in frame pixels.'),
        y: coordinateSchema.describe('Pointer y in frame pixels.')
    }),
    z.object({
        type: z.literal('click'),
        x: coordinateSchema.describe('Click x in frame pixels.'),
        y: coordinateSchema.describe('Click y in frame pixels.'),
        button: z.enum(MOUSE_BUTTON_NAMES).default('left').describe('Mouse button: left (default), right or middle. Sends a press and a release.')
    }),
    z.object({
        type: z.literal('scroll'),
        x: coordinateSchema.describe('Pointer x in frame pixels.'),
        y: coordinateSchema.describe('Pointer y in frame pixels.'),
        delta: z.number().int().min(-32768).max(32767).describe('Wheel delta in browser viewer units: positive scrolls up, about 120 per notch (the browser sends 360 per notch on Chrome).')
    }),
    z.object({
        type: z.literal('key'),
        key: z.enum(KEY_NAMES).describe('Key by browser event.code name, such as KeyA, Digit1, Numpad5, Enter, ArrowLeft, F12, ControlLeft.'),
        action: z.enum(KEY_ACTION_NAMES).default('press').describe('press (down then release, the default), down (hold) or up (release).')
    }),
    z.object({
        type: z.literal('text'),
        text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('Text to type as unicode key events, one down and one up per character.')
    })
]);

/** True when any action carries coordinates that need frame metadata. */
function actionsNeedCoordinates(actions) {
    return actions.some((action) => ((action.type === 'move') || (action.type === 'click') || (action.type === 'scroll')));
}

// Split one action into groups of commands. Commands inside a group go out
// back to back; a new group means the protocol wants a short pause first, such
// as between the two halves of a click or a key press.
function encodeActionGroups(action, frame) {
    switch (action.type) {
        case 'move': {
            const point = scaleCoordinates(action.x, action.y, frame);
            return [[encodeMouseMove(point.x, point.y)]];
        }
        case 'click': {
            const point = scaleCoordinates(action.x, action.y, frame);
            const button = (action.button == null) ? 'left' : action.button;
            return [
                [encodeMouseButton(button, true, point.x, point.y)],
                [encodeMouseButton(button, false, point.x, point.y)]
            ];
        }
        case 'scroll': {
            const point = scaleCoordinates(action.x, action.y, frame);
            return [[encodeMouseScroll(point.x, point.y, action.delta)]];
        }
        case 'key': {
            if (action.action === 'down') { return [[encodeKey('down', action.key)]]; }
            if (action.action === 'up') { return [[encodeKey('up', action.key)]]; }
            return [[encodeKey('down', action.key)], [encodeKey('up', action.key)]];
        }
        case 'text':
            return encodeText(action.text).map((command) => [command]);
        default:
            throw new DesktopCaptureError('Unsupported desktop input action "' + action.type + '"', 'EACTION');
    }
}

/**
* Apply validated actions to a started capture, in order. Resolves with the
* number of protocol commands sent. The scaling frame is options.frame when
* given, otherwise the capture's own latest frame. Commands inside a press and
* release pair are separated by options.delay milliseconds, and options.sleep
* can replace the real timer in tests. options.touch, when given, is called
* before each command group so a cache entry can be held for a long sequence.
*/
async function applyDesktopActions(capture, actions, options) {
    options = options || {};
    let frame = (options.frame !== undefined) ? options.frame : null;
    if ((frame == null) && (capture != null) && (typeof capture.getLatestFrame === 'function')) {
        frame = capture.getLatestFrame();
    }
    const delay = (options.delay != null) ? options.delay : DEFAULT_STEP_DELAY;
    const sleep = (typeof options.sleep === 'function') ? options.sleep : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    let commands = 0;
    for (const action of actions) {
        const groups = encodeActionGroups(action, frame);
        for (let i = 0; i < groups.length; i++) {
            if (typeof options.touch === 'function') { options.touch(); }
            for (const command of groups[i]) {
                if (capture.sendCommand(command) === false) {
                    throw new DesktopCaptureError('The desktop relay session is closed', 'E_CLOSED');
                }
                commands++;
            }
            if ((i + 1) < groups.length) { await sleep(delay); }
        }
    }
    return commands;
}

// Find the frame whose screen metadata maps coordinates for this call. A
// supplied frame wins, then the capture's latest frame. When neither exists
// and an action needs coordinates, wait briefly for the session's first frame
// and fall back to no metadata rather than failing the input.
async function resolveInputFrame(capture, actions, options) {
    if (options.frame !== undefined) { return options.frame; }
    const latest = (typeof capture.getLatestFrame === 'function') ? capture.getLatestFrame() : null;
    if (latest != null) { return latest; }
    if ((options.waitForFrame === false) || !actionsNeedCoordinates(actions) || (typeof capture.waitForFrame !== 'function')) { return null; }
    const timeout = (options.frameTimeout != null) ? options.frameTimeout : DEFAULT_FRAME_TIMEOUT;
    try {
        return await capture.waitForFrame({ latest: true, timeout: timeout });
    } catch (error) {
        return null;
    }
}

function confirmInput(count, deviceid) {
    return 'Applied ' + count + ' action' + ((count === 1) ? '' : 's') + ' to ' + deviceid + '.';
}

/**
* Resolve the account's desktop relay right from the connection handshake.
* Returns true when the account can open a desktop relay, false when it
* demonstrably cannot, and null when the handshake carries no userinfo to
* judge from. Full site administrators hold the right without any links;
* everyone else needs the remote control or relay right on the device's
* device group or on the device itself.
*/

function resolveDesktopRight(userInfo, node) {
    if (userInfo == null) { return null; }
    const siteadmin = userInfo.siteadmin;
    if (siteadmin === SITE_RIGHTS_ADMIN) { return true; }
    const links = userInfo.links;
    if ((links == null) || (typeof links !== 'object')) { return false; }
    for (const key of [node.meshid, node.id]) {
        if (key == null) { continue; }
        const link = links[key];
        if (link == null) { continue; }
        if (link.rights === SITE_RIGHTS_ADMIN) { return true; }
        if ((typeof link.rights === 'number') && ((link.rights & MESH_RIGHTS_DESKTOP) !== 0)) { return true; }
    }
    return false;
}

/** Describe the encoding a cached session was opened with, or null. */
function sessionEncoding(capture) {
    const encoding = (capture != null) ? capture.encoding : null;
    if (encoding == null) { return null; }
    for (const name of IMAGE_TYPE_NAMES) {
        if (IMAGE_TYPES[name] === encoding.imageType) {
            return { imageType: name, quality: encoding.compression, scale: encoding.scaling };
        }
    }
    return null;
}

/**
* Find one node in a nodes response by id, bare or partial, the way the
* catalogue's deviceinfo entry does. Returns { node, meshid } or null.
*/
function findNode(nodes, deviceid) {
    if ((nodes == null) || (typeof nodes !== 'object')) { return null; }
    for (const meshid of Object.keys(nodes)) {
        const group = nodes[meshid];
        if (!Array.isArray(group)) { continue; }
        for (const node of group) {
            if ((node != null) && (String(node._id).indexOf(deviceid) >= 0)) { return { node, meshid }; }
        }
    }
    return null;
}

/** Compact offline check: connectivity bit 0 (agent) or 1 (CIRA). */
function isOnline(node) {
    return (Number(node.conn) || 0) !== 0;
}

/**
* Report whether capturing a device's screen is currently possible.
*
* args.deviceid  Device id, bare or a full node id.
*
* options.client  Required. The connected MeshCentral client whose handshake
*                 carries userInfo.
* options.cache   Optional session cache to peek, never acquire. When absent,
*                 session.cached is reported as false.
* options.now     Clock in milliseconds, Date.now by default.
*
* Reads the device record through the client's nodes request and the account
* rights from the handshake. Never launches a relay session. Resolves with a
* text/JSON status report: 'ready' when capture can be attempted, 'blocked'
* with per-check reasons when it demonstrably cannot, and 'unknown' when a
* check cannot be evaluated (the account's rights are not in the handshake).
*/
async function desktopStatus(options, args) {
    options = options || {};
    const response = await options.client.request('nodes', {});
    const found = findNode((response != null) ? response.nodes : null, args.deviceid);
    if (found == null) {
        throw new Error('Invalid device id');
    }

    const node = found.node;
    const online = isOnline(node);
    const caps = (node.agent != null) && (typeof node.agent.caps === 'number') ? node.agent.caps : null;
    const desktopCapable = (caps == null) ? null : ((caps & AGENT_CAPS_DESKTOP) !== 0);
    const desktopRight = resolveDesktopRight(options.client.userInfo, { id: node._id, meshid: found.meshid });

    let entry = null;
    if (options.cache != null) { entry = options.cache.peek(args.deviceid); }
    const now = (typeof options.now === 'function') ? options.now() : Date.now();
    const session = {
        cached: entry != null,
        // A cached entry is at least a moment old; never report 0 and read as uncached.
        ageMs: (entry != null) ? Math.max(1, now - entry.lastUsed) : null,
        encoding: (entry != null) ? sessionEncoding(entry.capture) : null
    };

    const reasons = [];
    if (!online) { reasons.push('offline'); }
    if (desktopCapable === false) { reasons.push('desktop-unsupported'); }
    if (desktopRight === false) { reasons.push('missing-desktop-right'); }
    let status = (reasons.length > 0) ? 'blocked' : 'ready';
    if ((desktopRight == null) && (desktopCapable !== false) && online) {
        reasons.push('rights-unknown');
        status = 'unknown';
    }

    return textResult(JSON.stringify({
        status: status,
        reasons: reasons,
        device: { id: node._id, name: (node.name != null) ? node.name : null, meshid: found.meshid },
        online: online,
        agent: { desktop: desktopCapable, caps: caps },
        account: { desktopRight: desktopRight },
        session: session
    }, null, 2));
}

/**
* Apply validated input actions to a device's desktop.
*
* args.deviceid  Device id, bare or a full node id.
* args.actions   Ordered validated actions (move, click, scroll, key, text).
*
* createCapture is a factory (config) => DesktopCapture-compatible viewer.
* options.cache is a DesktopSessionCache: its entry is acquired for the call
* (marking it in use so the idle window cannot cut the sequence short),
* touched while actions are applied, finished on success so it stays cached,
* and released on failure so the next call renegotiates. options.capture is an
* already started capture to reuse instead; when neither is given a relay
* session is opened and released around the call. options.frame, options.delay,
* options.sleep, options.frameTimeout and options.waitForFrame are test seams.
*/
async function desktopInput(client, args, createCapture, options, defaults) {
    options = options || {};
    const cache = options.cache || null;
    let entry = null;
    let session = null;
    let capture = options.capture || null;
    try {
        if ((capture == null) && (cache != null)) {
            try {
                entry = await cache.acquire(args.deviceid, sessionOptionsFrom(args, defaults));
            } catch (error) {
                throw surfaceCaptureError(error);
            }
            capture = entry.capture;
        }
        if (capture == null) {
            // Launch failures (rights, consent, authentication) keep their own
            // message; only viewer errors borrow the server's words.
            session = await client.launchDesktopSession(args.deviceid, sessionOptionsFrom(args, defaults));
            capture = session.attach(createCapture(session.captureConfig));
            try {
                await capture.start();
            } catch (error) {
                throw surfaceCaptureError(error);
            }
        }
        const frame = await resolveInputFrame(capture, args.actions, options);
        try {
            await applyDesktopActions(capture, args.actions, Object.assign({}, options, {
                frame: frame,
                touch: ((cache != null) && (entry != null)) ? () => cache.touch(entry) : options.touch
            }));
        } catch (error) {
            throw surfaceCaptureError(error);
        }
        return textResult(confirmInput(args.actions.length, args.deviceid));
    } catch (error) {
        if ((cache != null) && (entry != null)) {
            try { await cache.release(args.deviceid, entry); } catch (ex) { }
        }
        throw error;
    } finally {
        if ((cache != null) && (entry != null)) { cache.finish(entry); }
        if (session != null) { try { await session.release(); } catch (error) { } }
    }
}

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
        handler: (args) => desktopSnapshot(options.client, args, createCapture, defaults)
    });

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
        handler: (args) => desktopFrames(cache, args, defaults)
    });

    registry.register({
        name: 'mesh_desktop_input',
        description: 'Move the mouse, click, scroll, press keys and type text on a device\'s desktop. Actions apply in order over one desktop relay session: a cached session is reused and held for the call when one exists, otherwise a session is opened and closed around the call. Coordinates are in frame pixels, the space of the image mesh_desktop_snapshot returns, and are scaled onto the remote screen from that frame\'s screen metadata. Use the look-act-look loop: mesh_desktop_snapshot, then mesh_desktop_input, then mesh_desktop_snapshot again to confirm the change. The account\'s desktop right and the server\'s consent, privacy, recording and view-only behaviour are unchanged.',
        inputSchema: {
            deviceid: z.string().min(1).describe('Device id of the machine to control, bare or a full node id (node//...).'),
            actions: z.array(desktopActionSchema).min(1).max(MAX_ACTIONS).describe('Ordered actions to apply: move, click, scroll, key or text; at most ' + MAX_ACTIONS + ' per call.')
        },
        target: (args) => args.deviceid,
        handler: (args) => desktopInput(options.client, args, createCapture, (acquireCapture != null)
            ? { capture: acquireCapture(args.deviceid) }
            : { cache: cache }, defaults)
    });

    registry.register({
        name: 'mesh_desktop_status',
        description: 'Report whether capturing a device\'s screen is currently possible, without opening a desktop relay session. Reports the device online state, the agent\'s desktop capability from its capability bit, the account\'s desktop relay right from the connection handshake, and whether a cached desktop session exists (with its age and encoding). A status of ready means a capture can be attempted; blocked lists the failing checks in reasons; unknown means a check cannot be evaluated, such as missing handshake rights. The device id may be a bare id or a full node id (node//...). The account\'s desktop right and the server\'s consent, privacy and recording behaviour are unchanged.',
        inputSchema: {
            deviceid: z.string().min(1).describe('Device id of the machine to inspect, bare or a full node id (node//...).')
        },
        target: (args) => args.deviceid,
        handler: (args) => desktopStatus({ client: options.client, cache: cache, now: options.now }, args)
    });

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
