'use strict';

/**
 * @description The mesh_desktop_input MCP tool.
 *
 * The input tool applies an ordered list of mouse, keyboard and text actions to
 * a desktop session. It acquires the session cache entry for the call so an
 * idle eviction cannot cut a long sequence short, and opens (and releases) a
 * relay session only when no session is cached. Coordinates are in the pixel
 * space of the latest frame from the same session and are scaled onto the
 * remote screen using that frame's screen metadata. Together with the snapshot
 * tool the two form the look-act-look loop:
 *
 *   mesh_desktop_snapshot  - see the current screen
 *   mesh_desktop_input     - move, click, scroll, press keys, type text
 *   mesh_desktop_snapshot  - see the screen change
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { z } = require('zod');
const {
    DesktopCaptureError,
    KEY_NAMES,
    encodeMouseMove,
    encodeMouseButton,
    encodeMouseScroll,
    encodeKey,
    encodeText,
    scaleCoordinates
} = require('./desktopcapture.js');
const { textResult } = require('./mcp-tool-registry.js');
const { startSessionCapture, releaseSession } = require('./desktop-capture-session.js');
const { sessionOptionsFrom, surfaceCaptureError } = require('./mcp-desktop-shared.js');

const MOUSE_BUTTON_NAMES = ['left', 'right', 'middle'];
const KEY_ACTION_NAMES = ['press', 'down', 'up'];
const MAX_ACTIONS = 200;
const MAX_TEXT_LENGTH = 1024;
const DEFAULT_STEP_DELAY = 5;
const DEFAULT_FRAME_TIMEOUT = 5000;

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
            try {
                capture = await startSessionCapture(session, createCapture);
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
        if (session != null) { await releaseSession(session); }
    }
}

/**
 * Declare the input tool on a registry.
 *
 * options.client          A connected MeshCentralClient (or a compatible object).
 * options.createCapture   Capture factory, (config) => viewer.
 * options.cache           The DesktopSessionCache shared with the frames tool.
 * options.acquireCapture  Optional function (deviceid) => capture|null. When it
 *                         returns a capture, mesh_desktop_input reuses that
 *                         started capture instead of acquiring from the cache.
 * options.defaults        Configured image defaults for sessionOptionsFrom.
 */
function registerInputTool(registry, options) {
    registry.register({
        name: 'mesh_desktop_input',
        description: 'Move the mouse, click, scroll, press keys and type text on a device\'s desktop. Actions apply in order over one desktop relay session: a cached session is reused and held for the call when one exists, otherwise a session is opened and closed around the call. Coordinates are in frame pixels, the space of the image mesh_desktop_snapshot returns, and are scaled onto the remote screen from that frame\'s screen metadata. Use the look-act-look loop: mesh_desktop_snapshot, then mesh_desktop_input, then mesh_desktop_snapshot again to confirm the change. The account\'s desktop right and the server\'s consent, privacy, recording and view-only behaviour are unchanged.',
        inputSchema: {
            deviceid: z.string().min(1).describe('Device id of the machine to control, bare or a full node id (node//...).'),
            actions: z.array(desktopActionSchema).min(1).max(MAX_ACTIONS).describe('Ordered actions to apply: move, click, scroll, key or text; at most ' + MAX_ACTIONS + ' per call.')
        },
        target: (args) => args.deviceid,
        handler: (args) => desktopInput(options.client, args, options.createCapture, (options.acquireCapture != null)
            ? { capture: options.acquireCapture(args.deviceid) }
            : { cache: options.cache }, options.defaults)
    });
}

module.exports = {
    registerInputTool: registerInputTool,
    desktopInput: desktopInput,
    applyDesktopActions: applyDesktopActions,
    desktopActionSchema: desktopActionSchema
};
