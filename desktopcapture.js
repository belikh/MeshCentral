/**
* @description MeshCentral server-side desktop relay viewer (DesktopCapture)
* @copyright Intel Corporation 2018-2022
* @license Apache-2.0
* @version v0.0.1
*/

/*jslint node: true */
/*jshint node: true */
/*jshint strict:false */
/*jshint -W097 */
/*jshint esversion: 8 */
"use strict";

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// KVM commands carried inside the desktop relay (p=2). Values match the browser
// viewer in public/scripts/agent-desktop-0.0.2.js and the desktop multiplexor
// in meshdesktopmultiplex.js.
const COMMANDS = {
    KEY: 1,
    MOUSE: 2,
    PICTURE: 3,
    COPY: 4,
    COMPRESSION: 5,
    REFRESH: 6,
    SCREEN: 7,
    PAUSE: 8,
    CTRLALTDEL: 10,
    GET_DISPLAYS: 11,
    SET_DISPLAY: 12,
    FRAME_RATE_TIMER: 13,
    INIT_TOUCH: 14,
    TOUCH: 15,
    CONNECTCOUNT: 16,
    MESSAGE: 17,
    KEYSTATE: 18,
    JUMBO: 27,
    DISCONNECT: 59,
    USERCONSENT: 63,
    ERROR: 65,
    DISPLAY_INFO: 82,
    KEYUNICODE: 85,
    INPUT_LOCK: 87,
    MOUSE_CURSOR: 88
};

// Wire image types: 1 = JPEG, 2 = PNG, 3 = TIFF, 4 = WebP.
const IMAGE_TYPES = { jpeg: 1, png: 2, tiff: 3, webp: 4 };
const IMAGE_TYPE_FORMATS = { 1: 'jpeg', 2: 'png', 3: 'tiff', 4: 'webp' };
const MIME_TYPES = { jpeg: 'image/jpeg', png: 'image/png', tiff: 'image/tiff', webp: 'image/webp' };

// Mouse button masks carried in the MOUSE command. The browser viewer sends
// the mask on press and the mask doubled on release (left 0x02 -> 0x04,
// right 0x08 -> 0x10, middle 0x20 -> 0x40).
const MOUSE_BUTTONS = { left: 0x02, right: 0x08, middle: 0x20 };

// Key action values for KEY and KEYUNICODE commands: 1 = down, 2 = up.
const KEY_ACTIONS = { down: 1, up: 2 };

// DOM event.code to Windows virtual key code, transcribed from the browser
// viewer's convertKeyCodeTable in public/scripts/agent-desktop-0.0.2.js.
// The KeyA-KeyZ, Digit0-Digit9 and Numpad0-Numpad9 families are computed by
// keycodeFromName instead of being listed here.
const KEYCODE_TABLE = {
    'Pause': 19,
    'CapsLock': 20,
    'Space': 32,
    'Quote': 222,
    'Minus': 189,
    'NumpadMultiply': 106,
    'NumpadAdd': 107,
    'PrintScreen': 44,
    'Comma': 188,
    'NumpadSubtract': 109,
    'NumpadDecimal': 110,
    'Period': 190,
    'Slash': 191,
    'NumpadDivide': 111,
    'Semicolon': 186,
    'Equal': 187,
    'OSLeft': 91,
    'BracketLeft': 219,
    'OSRight': 91,
    'Backslash': 220,
    'BracketRight': 221,
    'ContextMenu': 93,
    'Backquote': 192,
    'NumLock': 144,
    'ScrollLock': 145,
    'Backspace': 8,
    'Tab': 9,
    'Enter': 13,
    'NumpadEnter': 13,
    'Escape': 27,
    'Delete': 46,
    'Home': 36,
    'PageUp': 33,
    'PageDown': 34,
    'ArrowLeft': 37,
    'ArrowUp': 38,
    'ArrowRight': 39,
    'ArrowDown': 40,
    'End': 35,
    'Insert': 45,
    'F1': 112,
    'F2': 113,
    'F3': 114,
    'F4': 115,
    'F5': 116,
    'F6': 117,
    'F7': 118,
    'F8': 119,
    'F9': 120,
    'F10': 121,
    'F11': 122,
    'F12': 123,
    'ShiftLeft': 16,
    'ShiftRight': 16,
    'ControlLeft': 17,
    'ControlRight': 17,
    'AltLeft': 18,
    'AltRight': 18,
    'MetaLeft': 91,
    'MetaRight': 92,
    'VolumeMute': 181
};

// Every key name the input helpers accept: the table above plus the generated
// families, matching what the browser viewer's convertKeyCode understands.
const KEY_NAMES = (() => {
    const names = Object.keys(KEYCODE_TABLE);
    for (let i = 0; i < 26; i++) { names.push('Key' + String.fromCharCode(65 + i)); }
    for (let i = 0; i < 10; i++) { names.push('Digit' + String.fromCharCode(48 + i)); }
    for (let i = 0; i < 10; i++) { names.push('Numpad' + String.fromCharCode(48 + i)); }
    return Object.freeze(names);
})();

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_ENCODING = { imageType: 1, compression: 50, scaling: 1024, frameRate: 100 };

class DesktopCaptureError extends Error {
    constructor(message, code, details) {
        super(message);
        this.name = 'DesktopCaptureError';
        this.code = code;
        if (details != null) {
            for (const key of Object.keys(details)) {
                if (details[key] !== undefined) { this[key] = details[key]; }
            }
        }
    }
}

function toBuffer(input) {
    if (input == null) { return null; }
    if (Buffer.isBuffer(input)) { return input; }
    if (input instanceof Uint8Array) { return Buffer.from(input.buffer, input.byteOffset, input.byteLength); }
    if (input instanceof ArrayBuffer) { return Buffer.from(input); }
    return null;
}

function tryParseJson(text) {
    try {
        const value = JSON.parse(text);
        return (typeof value == 'object') ? value : null;
    } catch (ex) {
        return null;
    }
}

function normalizeRelayUrl(input) {
    if (typeof input != 'string') { throw new TypeError('DesktopCapture requires a relay websocket url'); }
    let url = input.trim();
    if (url.length == 0) { throw new TypeError('DesktopCapture requires a relay websocket url'); }
    url = url.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    if (!/^wss?:\/\//i.test(url)) { throw new TypeError('DesktopCapture url must be a ws:// or wss:// relay url'); }
    let parsed;
    try { parsed = new URL(url); } catch (ex) { throw new TypeError('DesktopCapture url is not a valid websocket url'); }
    if (parsed.searchParams.get('browser') !== '1') { parsed.searchParams.set('browser', '1'); }
    return parsed.toString();
}

function normalizeImageType(value) {
    const type = Number(value);
    if (!Number.isInteger(type) || IMAGE_TYPE_FORMATS[type] == null) { throw new TypeError('DesktopCapture imageType must be 1 (JPEG), 2 (PNG), 3 (TIFF) or 4 (WebP)'); }
    return type;
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) { return fallback; }
    return Math.min(max, Math.max(min, Math.round(number)));
}

// Wrap a payload in the 4-byte viewer header (command, total size) used by the
// browser viewer and understood by the agent and the desktop multiplexor.
function encodeCommand(command, payload) {
    const body = (payload == null) ? Buffer.alloc(0) : Buffer.from(payload);
    const buffer = Buffer.alloc(4 + body.length);
    buffer.writeUInt16BE(command & 0xFFFF, 0);
    buffer.writeUInt16BE(buffer.length, 2);
    body.copy(buffer, 4);
    return buffer;
}

function encodeCompressionLevel(encoding) {
    const buffer = Buffer.alloc(10);
    buffer.writeUInt16BE(COMMANDS.COMPRESSION, 0);
    buffer.writeUInt16BE(10, 2);
    buffer[4] = encoding.imageType;
    buffer[5] = encoding.compression;
    buffer.writeUInt16BE(encoding.scaling, 6);
    buffer.writeUInt16BE(encoding.frameRate, 8);
    return buffer;
}

function encodePause(paused) {
    return encodeCommand(COMMANDS.PAUSE, Buffer.from([paused ? 1 : 0]));
}

function encodeRefresh() {
    return encodeCommand(COMMANDS.REFRESH);
}

function encodeGetDisplays() {
    return encodeCommand(COMMANDS.GET_DISPLAYS);
}

function encodeSetDisplay(display) {
    return encodeCommand(COMMANDS.SET_DISPLAY, Buffer.from([(display >> 8) & 0xFF, display & 0xFF]));
}

function encodeRemoteInputLock(code) {
    return encodeCommand(COMMANDS.INPUT_LOCK, Buffer.from([code & 0xFF]));
}

// Resolve a browser event.code name (KeyA, Digit1, Numpad5, Enter, ArrowLeft,
// ControlLeft and so on) to the Windows virtual key code the agent expects.
// Returns null for a name the browser viewer would not understand either.
function keycodeFromName(name) {
    if ((typeof name != 'string') || (name.length == 0)) { return null; }
    if (name.startsWith('Key') && (name.length == 4)) { return name.charCodeAt(3); }
    if (name.startsWith('Digit') && (name.length == 6)) { return name.charCodeAt(5); }
    if (name.startsWith('Numpad') && (name.length == 7)) { return name.charCodeAt(6) + 48; }
    const keycode = KEYCODE_TABLE[name];
    return (keycode === undefined) ? null : keycode;
}

function normalizeCoordinate(value, axis) {
    const number = Number(value);
    if (!Number.isInteger(number) || (number < 0) || (number > 0xFFFF)) {
        throw new TypeError('Desktop input ' + axis + ' coordinate must be an integer between 0 and 65535');
    }
    return number;
}

function normalizeKeycode(value) {
    const keycode = (typeof value == 'string') ? keycodeFromName(value) : Number(value);
    if ((keycode == null) || !Number.isInteger(keycode) || (keycode < 0) || (keycode > 0xFF)) {
        throw new TypeError('Unsupported desktop input key "' + value + '"');
    }
    return keycode;
}

function normalizeKeyAction(action) {
    const value = (typeof action == 'string') ? KEY_ACTIONS[action] : Number(action);
    if ((value != KEY_ACTIONS.down) && (value != KEY_ACTIONS.up)) {
        throw new TypeError('Desktop input key action must be "down" or "up"');
    }
    return value;
}

// Mouse move: command 2, size 10, zero flags, then x and y as 16-bit values.
function encodeMouseMove(x, y) {
    const px = normalizeCoordinate(x, 'x'), py = normalizeCoordinate(y, 'y');
    return encodeCommand(COMMANDS.MOUSE, Buffer.from([0x00, 0x00, (px >> 8) & 0xFF, px & 0xFF, (py >> 8) & 0xFF, py & 0xFF]));
}

// Mouse button press (down true) or release (down false) at a position. The
// browser viewer doubles the mask on release, which is the wire convention the
// agent reads.
function encodeMouseButton(button, down, x, y) {
    const mask = (typeof button == 'string') ? MOUSE_BUTTONS[button] : null;
    if (mask == null) { throw new TypeError('Desktop input mouse button must be "left", "right" or "middle"'); }
    if (typeof down != 'boolean') { throw new TypeError('Desktop input mouse button state must be a boolean'); }
    const px = normalizeCoordinate(x, 'x'), py = normalizeCoordinate(y, 'y');
    const flags = down ? mask : ((mask * 2) & 0xFF);
    return encodeCommand(COMMANDS.MOUSE, Buffer.from([0x00, flags, (px >> 8) & 0xFF, px & 0xFF, (py >> 8) & 0xFF, py & 0xFF]));
}

// Mouse wheel scroll at a position, command 2 size 12. The delta is encoded
// exactly like the browser viewer: negative deltas use 255 minus the magnitude
// bytes, not a plain two's complement, so a -120 notch is 0xFF87.
function encodeMouseScroll(x, y, delta) {
    const px = normalizeCoordinate(x, 'x'), py = normalizeCoordinate(y, 'y');
    const value = Number(delta);
    if (!Number.isInteger(value) || (value < -32768) || (value > 32767)) {
        throw new TypeError('Desktop input scroll delta must be an integer between -32768 and 32767');
    }
    let deltaHigh = 0, deltaLow = 0;
    if (value < 0) {
        const magnitude = Math.abs(value);
        deltaHigh = 255 - (magnitude >> 8);
        deltaLow = 255 - (magnitude & 0xFF);
    } else {
        deltaHigh = (value >> 8) & 0xFF;
        deltaLow = value & 0xFF;
    }
    return encodeCommand(COMMANDS.MOUSE, Buffer.from([0x00, 0x00, (px >> 8) & 0xFF, px & 0xFF, (py >> 8) & 0xFF, py & 0xFF, deltaHigh, deltaLow]));
}

// Keyboard scancode event: command 1, size 6. Without the extended flag a
// down/up is 0/1; with it the browser viewer sends 4/3.
function encodeKey(action, keycode, extended) {
    const normalized = normalizeKeyAction(action);
    const key = normalizeKeycode(keycode);
    let state = normalized - 1;
    if (extended === true) { state = (state == 1) ? 3 : 4; }
    return encodeCommand(COMMANDS.KEY, Buffer.from([state, key]));
}

// Unicode keyboard event: command 85, size 7, action byte then the UTF-16
// code unit.
function encodeKeyUnicode(action, codepoint) {
    const normalized = normalizeKeyAction(action);
    const value = Number(codepoint);
    if (!Number.isInteger(value) || (value < 0) || (value > 0xFFFF)) {
        throw new TypeError('Desktop input unicode codepoint must be an integer between 0 and 65535');
    }
    return encodeCommand(COMMANDS.KEYUNICODE, Buffer.from([normalized - 1, (value >> 8) & 0xFF, value & 0xFF]));
}

// Type a string: one down and one up unicode command per UTF-16 code unit,
// exactly the order the browser viewer produces for keypress plus keyup. Each
// command must be sent as its own relay message.
function encodeText(text) {
    if (typeof text != 'string') { throw new TypeError('Desktop input text must be a string'); }
    const commands = [];
    for (let i = 0; i < text.length; i++) {
        const codepoint = text.charCodeAt(i);
        commands.push(encodeKeyUnicode(KEY_ACTIONS.down, codepoint));
        commands.push(encodeKeyUnicode(KEY_ACTIONS.up, codepoint));
    }
    return commands;
}

// Map a point from a frame's image space onto the remote screen using the
// frame's screen metadata. Frames are what the caller saw (a tile with its own
// origin and pixel size), while the wire input commands take screen
// coordinates, so the frame origin is added before scaling and the result is
// clamped to the screen. Without usable metadata the point is passed through.
function scaleCoordinates(x, y, frame) {
    let screenX = Number(x), screenY = Number(y);
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
        throw new TypeError('Desktop input coordinates must be finite numbers');
    }
    const screen = (frame != null) ? frame.screen : null;
    const width = (frame != null) ? Number(frame.width) : NaN;
    const height = (frame != null) ? Number(frame.height) : NaN;
    if ((screen != null) && Number.isFinite(Number(screen.width)) && Number.isFinite(Number(screen.height)) &&
        (Number(screen.width) > 0) && (Number(screen.height) > 0) && (width > 0) && (height > 0)) {
        const originX = Number.isFinite(Number(frame.x)) ? Number(frame.x) : 0;
        const originY = Number.isFinite(Number(frame.y)) ? Number(frame.y) : 0;
        screenX = (originX + screenX) * (Number(screen.width) / width);
        screenY = (originY + screenY) * (Number(screen.height) / height);
        return {
            x: Math.max(0, Math.min(Number(screen.width) - 1, Math.round(screenX))),
            y: Math.max(0, Math.min(Number(screen.height) - 1, Math.round(screenY)))
        };
    }
    return { x: Math.max(0, Math.min(0xFFFF, Math.round(screenX))), y: Math.max(0, Math.min(0xFFFF, Math.round(screenY))) };
}

// Decode one relay command. Jumbo packets (command 27, size 8) wrap a larger
// command whose 32-bit length sits at offset 4 and whose bytes start at offset 8.
// Returns null when the buffer carries no usable command, or an object with
// incomplete: true when a declared size has not yet been fully received.
function decodeCommand(input) {
    const buffer = toBuffer(input);
    if (buffer == null || buffer.length < 4) { return null; }
    let command = buffer.readUInt16BE(0);
    let size = buffer.readUInt16BE(2);
    let jumbo = false;
    if ((command == COMMANDS.JUMBO) && (size == 8)) {
        if (buffer.length < 12) { return { command, size, data: buffer, jumbo: true, incomplete: true }; }
        const innerSize = buffer.readUInt32BE(4);
        if ((innerSize < 4) || (buffer.length < (innerSize + 8))) { return { command, size: innerSize, data: buffer, jumbo: true, incomplete: true }; }
        command = buffer.readUInt16BE(8);
        size = buffer.readUInt16BE(10);
        jumbo = true;
        return { command, size: innerSize, data: buffer.subarray(8, innerSize + 8), jumbo, incomplete: false };
    }
    if (size < 4) { return null; }
    if (buffer.length < size) { return { command, size, data: buffer, jumbo, incomplete: true }; }
    return { command, size, data: buffer.subarray(0, size), jumbo, incomplete: false };
}

function detectImageFormat(input) {
    const buffer = toBuffer(input);
    if (buffer == null) { return null; }
    if ((buffer.length >= 3) && (buffer[0] == 0xFF) && (buffer[1] == 0xD8) && (buffer[2] == 0xFF)) { return 'jpeg'; }
    if ((buffer.length >= 8) && (buffer[0] == 0x89) && (buffer[1] == 0x50) && (buffer[2] == 0x4E) && (buffer[3] == 0x47) && (buffer[4] == 0x0D) && (buffer[5] == 0x0A) && (buffer[6] == 0x1A) && (buffer[7] == 0x0A)) { return 'png'; }
    if ((buffer.length >= 4) && (((buffer[0] == 0x49) && (buffer[1] == 0x49) && (buffer[2] == 0x2A) && (buffer[3] == 0x00)) || ((buffer[0] == 0x4D) && (buffer[1] == 0x4D) && (buffer[2] == 0x00) && (buffer[3] == 0x2A)))) { return 'tiff'; }
    if ((buffer.length >= 12) && (buffer.toString('latin1', 0, 4) == 'RIFF') && (buffer.toString('latin1', 8, 12) == 'WEBP')) { return 'webp'; }
    return null;
}

function jpegDimensions(buffer) {
    if ((buffer.length < 4) || (buffer[0] != 0xFF) || (buffer[1] != 0xD8)) { return null; }
    let offset = 2;
    while ((offset + 9) < buffer.length) {
        if (buffer[offset] != 0xFF) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker == 0xFF) { offset++; continue; }
        if ((marker == 0x01) || ((marker >= 0xD0) && (marker <= 0xD9))) { offset += 2; continue; }
        if ((offset + 3) >= buffer.length) { return null; }
        const length = buffer.readUInt16BE(offset + 2);
        if ((marker >= 0xC0) && (marker <= 0xCF) && (marker != 0xC4) && (marker != 0xC8) && (marker != 0xCC)) {
            if ((offset + 8) >= buffer.length) { return null; }
            return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        if (length < 2) { return null; }
        offset += 2 + length;
    }
    return null;
}

function pngDimensions(buffer) {
    if (buffer.length < 24) { return null; }
    if (buffer.toString('latin1', 12, 16) != 'IHDR') { return null; }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function webpDimensions(buffer) {
    if (buffer.length < 25) { return null; }
    const chunk = buffer.toString('latin1', 12, 16);
    if ((chunk == 'VP8X') && (buffer.length >= 30)) {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (chunk == 'VP8L') {
        const b1 = buffer[21], b2 = buffer[22], b3 = buffer[23], b4 = buffer[24];
        return { width: 1 + (((b2 & 0x3F) << 8) | b1), height: 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 >> 6) & 0x03)) };
    }
    if ((chunk == 'VP8 ') && (buffer.length >= 30)) {
        if ((buffer[23] == 0x9D) && (buffer[24] == 0x01) && (buffer[25] == 0x2A)) {
            return { width: buffer.readUInt16LE(26) & 0x3FFF, height: buffer.readUInt16LE(28) & 0x3FFF };
        }
    }
    return null;
}

function tiffDimensions(buffer) {
    if (buffer.length < 8) { return null; }
    let littleEndian;
    if ((buffer[0] == 0x49) && (buffer[1] == 0x49)) { littleEndian = true; }
    else if ((buffer[0] == 0x4D) && (buffer[1] == 0x4D)) { littleEndian = false; }
    else { return null; }
    const read16 = (offset) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const read32 = (offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (read16(2) != 42) { return null; }
    const ifdOffset = read32(4);
    if ((ifdOffset + 2) > buffer.length) { return null; }
    const count = read16(ifdOffset);
    let width = null, height = null;
    for (let i = 0, pointer = ifdOffset + 2; (i < count) && ((pointer + 12) <= buffer.length); i++, pointer += 12) {
        const tag = read16(pointer);
        if ((tag != 0x0100) && (tag != 0x0101)) { continue; }
        const type = read16(pointer + 2);
        if (read32(pointer + 4) != 1) { continue; }
        let value = null;
        if (type == 3) { value = read16(pointer + 8); }
        else if (type == 4) { value = read32(pointer + 8); }
        if (value == null) { continue; }
        if (tag == 0x0100) { width = value; } else { height = value; }
        if ((width != null) && (height != null)) { break; }
    }
    return ((width != null) && (height != null)) ? { width, height } : null;
}

function readImageDimensions(input) {
    const buffer = toBuffer(input);
    if (buffer == null) { return null; }
    switch (detectImageFormat(buffer)) {
        case 'jpeg': return jpegDimensions(buffer);
        case 'png': return pngDimensions(buffer);
        case 'tiff': return tiffDimensions(buffer);
        case 'webp': return webpDimensions(buffer);
        default: return null;
    }
}

// Parse a complete relay command into a protocol message. Returns null when the
// command is incomplete or malformed.
function parseMessage(input) {
    const decoded = decodeCommand(input);
    if ((decoded == null) || (decoded.incomplete == true)) { return null; }
    const { command, data } = decoded;
    switch (command) {
        case COMMANDS.PICTURE: {
            if (data.length < 8) { return null; }
            const image = Buffer.from(data.subarray(8));
            const format = detectImageFormat(image);
            const dimensions = readImageDimensions(image);
            return {
                type: 'frame',
                x: data.readUInt16BE(4),
                y: data.readUInt16BE(6),
                data: image,
                format,
                mimeType: (format != null) ? MIME_TYPES[format] : null,
                width: (dimensions != null) ? dimensions.width : null,
                height: (dimensions != null) ? dimensions.height : null
            };
        }
        case COMMANDS.COPY: {
            if (data.length < 16) { return null; }
            return {
                type: 'copy',
                sourceX: data.readUInt16BE(4),
                sourceY: data.readUInt16BE(6),
                destX: data.readUInt16BE(8),
                destY: data.readUInt16BE(10),
                width: data.readUInt16BE(12),
                height: data.readUInt16BE(14)
            };
        }
        case COMMANDS.SCREEN: {
            if (data.length < 8) { return null; }
            return { type: 'screen', width: data.readUInt16BE(4), height: data.readUInt16BE(6) };
        }
        case COMMANDS.GET_DISPLAYS: {
            if (data.length < 6) { return null; }
            const count = data.readUInt16BE(4);
            const displays = [];
            for (let i = 0; i < count; i++) {
                const pointer = 6 + (i * 2);
                if ((pointer + 2) > data.length) { return null; }
                displays.push(data.readUInt16BE(pointer));
            }
            const selectedPointer = 6 + (count * 2);
            return { type: 'displays', count, displays, selected: ((selectedPointer + 2) <= data.length) ? data.readUInt16BE(selectedPointer) : null };
        }
        case COMMANDS.KEYSTATE: {
            if (data.length < 5) { return null; }
            return { type: 'keystate', state: data[4] };
        }
        case COMMANDS.MESSAGE: {
            return { type: 'message', message: data.subarray(4).toString('utf8') };
        }
        case COMMANDS.USERCONSENT: {
            return { type: 'consent', state: (data.length >= 5) ? data[4] : null, data: Buffer.from(data.subarray(4)) };
        }
        case COMMANDS.ERROR: {
            return { type: 'alert', message: data.subarray(4).toString('utf8') };
        }
        case COMMANDS.DISPLAY_INFO: {
            if ((data.length < 14) || (((data.length - 4) % 10) != 0)) { return null; }
            const displays = [];
            for (let pointer = 4; pointer < data.length; pointer += 10) {
                displays.push({
                    id: data.readUInt16BE(pointer),
                    x: data.readUInt16BE(pointer + 2),
                    y: data.readUInt16BE(pointer + 4),
                    width: data.readUInt16BE(pointer + 6),
                    height: data.readUInt16BE(pointer + 8)
                });
            }
            return { type: 'displayinfo', displays };
        }
        case COMMANDS.INPUT_LOCK: {
            if (data.length < 5) { return null; }
            return { type: 'inputlock', locked: (data[4] != 0) };
        }
        case COMMANDS.MOUSE_CURSOR: {
            if (data.length < 5) { return null; }
            return { type: 'cursor', cursor: data[4] };
        }
        default:
            return { type: 'unknown', command, data: Buffer.from(data.subarray(4)) };
    }
}

// A server-side viewer peer on the MeshCentral desktop relay (meshrelay.ashx?p=2).
// It joins exactly like the browser viewer: connect, wait for the relay to send
// 'c' (or 'cr' when recording), send JSON options followed by the protocol start
// '2', negotiate image framing, then receive screen-size announcements and image
// frames. The relay url and tunnel details are always supplied by the caller so a
// control client can own authentication and tunnel launch.
class DesktopCapture extends EventEmitter {
    constructor(config) {
        super();
        if ((config == null) || (typeof config != 'object')) { throw new TypeError('DesktopCapture requires a configuration object with a relay url'); }
        this.url = normalizeRelayUrl(config.url);
        this.config = Object.assign({}, config);
        this.options = (config.options === undefined) ? {} : config.options;
        this.encoding = {
            imageType: normalizeImageType(config.imageType === undefined ? DEFAULT_ENCODING.imageType : config.imageType),
            compression: clampInteger(config.compression, 0, 100, DEFAULT_ENCODING.compression),
            scaling: clampInteger(config.scaling, 1, 65535, DEFAULT_ENCODING.scaling),
            frameRate: clampInteger(config.frameRate, 0, 65535, DEFAULT_ENCODING.frameRate)
        };
        this.timeout = clampInteger(config.timeout, 1, 0x7FFFFFFF, DEFAULT_TIMEOUT);
        this.connectTimeout = (config.connectTimeout == null) ? this.timeout : clampInteger(config.connectTimeout, 1, 0x7FFFFFFF, this.timeout);
        this.state = 'idle';
        this.screen = null;
        this.latestFrame = null;
        this.frameCount = 0;
        this.consent = null;
        this.lastAlert = null;
        this.lastError = null;
        this.closeCode = null;
        this.closeReason = null;
        this.recording = false;
        this._socket = null;
        this._waiters = [];
        this._startPromise = null;
        this._startResolve = null;
        this._startReject = null;
        this._startPending = false;
        this._closePromise = null;
        this._closeResolve = null;
        this._closeRequested = false;
        this._closed = false;
        this._connectTimer = null;
        this._closeTimer = null;
    }

    // Open the relay and negotiate image framing. Resolves once the relay has
    // announced the connection and the negotiation bytes have been sent.
    start() {
        if (this._startPromise != null) { return this._startPromise; }
        if (this._closed) { return Promise.reject(this._closedError()); }
        this._setState('connecting');
        this._startPending = true;
        this._startPromise = new Promise((resolve, reject) => {
            this._startResolve = resolve;
            this._startReject = reject;
        });
        if (this.connectTimeout > 0) {
            this._connectTimer = setTimeout(() => {
                this._shutdown(new DesktopCaptureError('Timed out waiting for the desktop relay to connect', 'E_TIMEOUT'));
            }, this.connectTimeout);
            if (this._connectTimer.unref) { this._connectTimer.unref(); }
        }
        const Socket = this.config.WebSocket || WebSocket;
        try {
            this._socket = new Socket(this.url, this.config.socketOptions || {});
        } catch (ex) {
            this._shutdown(new DesktopCaptureError('Unable to open the desktop relay connection: ' + ex.message, 'E_CONNECT', { cause: ex }));
            return this._startPromise;
        }
        this._socket.on('open', () => { });
        this._socket.on('message', (data, isBinary) => this._onMessage(data, isBinary));
        this._socket.on('error', (error) => this._onSocketError(error));
        this._socket.on('close', (code, reason) => this._onSocketClose(code, reason));
        return this._startPromise;
    }

    // Resolve with the latest buffered frame, or wait for the next frame to
    // arrive. options may be a timeout in milliseconds or an object with
    // { timeout, latest }. timeout <= 0 waits forever; latest: true returns the
    // buffered frame when one exists instead of waiting for a new one.
    waitForFrame(options) {
        let timeout = this.timeout;
        let latest = false;
        if (typeof options == 'number') { timeout = options; }
        else if (options != null) {
            if (typeof options.timeout == 'number') { timeout = options.timeout; }
            latest = (options.latest === true);
        }
        if (this._closed) { return Promise.reject(this._closedError()); }
        if (latest && (this.latestFrame != null)) { return Promise.resolve(this.latestFrame); }
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            if (Number.isFinite(timeout) && (timeout > 0)) {
                waiter.timer = setTimeout(() => {
                    const index = this._waiters.indexOf(waiter);
                    if (index >= 0) { this._waiters.splice(index, 1); }
                    reject(new DesktopCaptureError('Timed out waiting for a desktop frame', 'E_TIMEOUT', { serverMessage: this.lastAlert || undefined }));
                }, timeout);
                if (waiter.timer.unref) { waiter.timer.unref(); }
            }
            this._waiters.push(waiter);
        });
    }

    getLatestFrame() { return this.latestFrame; }

    getScreenSize() { return (this.screen == null) ? null : { width: this.screen.width, height: this.screen.height }; }

    isConnected() { return this.state === 'connected'; }

    // Update the image framing (image type, compression, scaling, frame rate) and
    // send the negotiation command again when connected.
    setEncoding(encoding) {
        if (encoding != null) {
            if (encoding.imageType !== undefined) { this.encoding.imageType = normalizeImageType(encoding.imageType); }
            if (encoding.compression !== undefined) { this.encoding.compression = clampInteger(encoding.compression, 0, 100, this.encoding.compression); }
            if (encoding.scaling !== undefined) { this.encoding.scaling = clampInteger(encoding.scaling, 1, 65535, this.encoding.scaling); }
            if (encoding.frameRate !== undefined) { this.encoding.frameRate = clampInteger(encoding.frameRate, 0, 65535, this.encoding.frameRate); }
        }
        if (this.state === 'connected') { this._sendBinary(encodeCompressionLevel(this.encoding)); }
        return this.encoding;
    }

    // Ask the agent to resend the full screen from the last screen-size marker.
    sendRefresh() {
        return this._sendBinary(encodeRefresh());
    }

    // Send a raw protocol command (used by tests and by future input support).
    sendCommand(buffer) {
        return this._sendBinary(buffer);
    }

    // Close the session cleanly: tell the relay, close the websocket, reject any
    // pending frame waiters and stop all timers. Safe to call more than once.
    close() {
        if (this._closePromise != null) { return this._closePromise; }
        this._closeRequested = true;
        if (this._closed) {
            this._closePromise = Promise.resolve();
            return this._closePromise;
        }
        this._closePromise = new Promise((resolve) => { this._closeResolve = resolve; });
        if (this._socket == null) {
            this._shutdown(null);
            return this._closePromise;
        }
        const socket = this._socket;
        if (socket.readyState === WebSocket.OPEN) {
            try { this._sendText(JSON.stringify({ ctrlChannel: '102938', type: 'close' })); } catch (ex) { }
            try { socket.close(); } catch (ex) { }
            this._closeTimer = setTimeout(() => { try { socket.terminate(); } catch (ex) { } }, 1000);
            if (this._closeTimer.unref) { this._closeTimer.unref(); }
        } else {
            try { socket.terminate(); } catch (ex) { }
            this._shutdown(null);
        }
        return this._closePromise;
    }

    // The ws client delivers text frames as Buffers with isBinary false, so the
    // flag (not the JS type) decides between the text and binary protocols.
    _onMessage(data, isBinary) {
        if ((isBinary === false) || (typeof data == 'string')) {
            const buffer = (typeof data == 'string') ? null : toBuffer(data);
            this._onText((buffer != null) ? buffer.toString('utf8') : String(data));
            return;
        }
        const buffer = toBuffer(data);
        if (buffer != null) { this._onBinary(buffer); }
    }

    _onText(text) {
        if (this.state === 'connecting') {
            if ((text == 'c') || (text == 'cr')) { this._onConnected(text == 'cr'); return; }
            const json = tryParseJson(text);
            if ((json != null) && (json.action == 'close')) {
                this._shutdown(new DesktopCaptureError(json.msg || 'The desktop relay refused the session', 'E_DENIED', { serverMessage: json.msg || null, cause: json.cause || null }));
            }
            return;
        }
        if (this.state !== 'connected') { return; }
        const json = tryParseJson(text);
        if ((json == null) || (json.ctrlChannel != '102938')) { return; }
        if (json.type == 'ping') { this._sendText(JSON.stringify({ ctrlChannel: '102938', type: 'pong' })); }
        else if (json.type == 'console') { this.emit('console', json); }
        else if (json.type == 'metadata') { this.emit('metadata', json); }
        else if (json.type == 'close') { this.emit('closeNotice', json); }
    }

    _onConnected(recording) {
        if (this._connectTimer != null) { clearTimeout(this._connectTimer); this._connectTimer = null; }
        this.recording = recording;
        try {
            if (this.options != null) {
                const options = Object.assign({}, this.options);
                options.type = 'options';
                this._sendText(JSON.stringify(options));
            }
            this._sendText(String(2));
            this._sendBinary(encodeCompressionLevel(this.encoding));
            this._sendBinary(encodePause(false));
            if (this.config.refresh !== false) { this._sendBinary(encodeRefresh()); }
        } catch (ex) {
            this._shutdown(new DesktopCaptureError('Failed to negotiate the desktop session: ' + ex.message, 'E_HANDSHAKE', { cause: ex }));
            return;
        }
        this._setState('connected');
        this._startPending = false;
        const resolve = this._startResolve;
        this._startResolve = null;
        this._startReject = null;
        if (resolve != null) { resolve(this); }
    }

    _onBinary(buffer) {
        const message = parseMessage(buffer);
        if (message == null) { return; }
        this.emit('command', message);
        switch (message.type) {
            case 'frame': this._onFrame(message); break;
            case 'screen': this._onScreenSize(message); break;
            case 'alert': this.lastAlert = message.message; this.emit('alert', message.message); break;
            case 'message': this.emit('message', message.message); break;
            case 'consent': this.consent = message; this.emit('consent', message); break;
            default: break;
        }
    }

    _onFrame(message) {
        this.frameCount++;
        const fallbackFormat = IMAGE_TYPE_FORMATS[this.encoding.imageType] || null;
        const format = message.format || fallbackFormat;
        const frame = {
            type: 'frame',
            index: this.frameCount,
            timestamp: Date.now(),
            imageType: this.encoding.imageType,
            format: message.format || null,
            mimeType: (format != null) ? MIME_TYPES[format] : null,
            data: message.data,
            length: message.data.length,
            x: message.x,
            y: message.y,
            width: message.width,
            height: message.height,
            screen: (this.screen == null) ? null : { width: this.screen.width, height: this.screen.height }
        };
        this.latestFrame = frame;
        this.emit('frame', frame);
        if (this._waiters.length > 0) {
            const waiters = this._waiters.splice(0);
            for (const waiter of waiters) {
                if (waiter.timer != null) { clearTimeout(waiter.timer); }
                waiter.resolve(frame);
            }
        }
    }

    // Mirror the browser viewer: when the agent announces a new screen size,
    // re-send framing and unpause so tiles continue to flow at the new size.
    _onScreenSize(message) {
        const changed = (this.screen == null) || (this.screen.width != message.width) || (this.screen.height != message.height);
        this.screen = { width: message.width, height: message.height };
        this.emit('screen', this.getScreenSize());
        if (changed && (this.state === 'connected')) {
            this._sendBinary(encodeCompressionLevel(this.encoding));
            this._sendBinary(encodePause(false));
        }
    }

    _onSocketError(error) {
        this.lastError = new DesktopCaptureError('Desktop relay connection error: ' + error.message, 'E_CONNECT', { cause: error });
    }

    _onSocketClose(code, reason) {
        this.closeCode = code;
        this.closeReason = (reason == null) ? null : reason.toString();
        if (this._closed) { return; }
        let error = this.lastError;
        if ((error == null) && this._startPending) {
            error = new DesktopCaptureError('The desktop relay closed the connection before the session was ready', 'E_HANDSHAKE', { closeCode: code, closeReason: this.closeReason || undefined, serverMessage: this.lastAlert || undefined });
        } else if ((error == null) && !this._closeRequested) {
            error = new DesktopCaptureError('The desktop relay connection closed unexpectedly', 'E_CLOSED', { closeCode: code, closeReason: this.closeReason || undefined, serverMessage: this.lastAlert || undefined });
        }
        this._shutdown(error || null);
    }

    _sendText(text) {
        if ((this._socket == null) || (this._socket.readyState !== WebSocket.OPEN)) { return false; }
        this._socket.send(text);
        return true;
    }

    _sendBinary(buffer) {
        if ((this._socket == null) || (this._socket.readyState !== WebSocket.OPEN)) { return false; }
        this._socket.send(buffer);
        return true;
    }

    _closedError() {
        return new DesktopCaptureError('The desktop relay session is closed', 'E_CLOSED', {
            serverMessage: this.lastAlert || undefined,
            closeCode: (this.closeCode == null) ? undefined : this.closeCode,
            closeReason: this.closeReason || undefined
        });
    }

    _setState(state) {
        if (this.state === state) { return; }
        this.state = state;
        this.emit('state', state);
    }

    _shutdown(error) {
        if (this._closed) { return; }
        this._closed = true;
        if ((error != null) && (this.lastError == null)) { this.lastError = error; }
        if (this._connectTimer != null) { clearTimeout(this._connectTimer); this._connectTimer = null; }
        if (this._closeTimer != null) { clearTimeout(this._closeTimer); this._closeTimer = null; }
        const socket = this._socket;
        this._socket = null;
        if (socket != null) {
            socket.removeAllListeners();
            try { socket.terminate(); } catch (ex) { }
        }
        const pendingStart = this._startPending;
        this._startPending = false;
        const rejectStart = this._startReject;
        this._startResolve = null;
        this._startReject = null;
        const closedError = error || this._closedError();
        this._setState('closed');
        if (pendingStart && (rejectStart != null)) { rejectStart(closedError); }
        if (this._waiters.length > 0) {
            const waiters = this._waiters.splice(0);
            for (const waiter of waiters) {
                if (waiter.timer != null) { clearTimeout(waiter.timer); }
                waiter.reject(closedError);
            }
        }
        if (error != null) {
            if (this.listenerCount('error') > 0) { this.emit('error', error); }
            this.emit('close', error);
        } else {
            this.emit('close', null);
        }
        if (this._closeResolve != null) {
            const resolve = this._closeResolve;
            this._closeResolve = null;
            resolve();
        }
    }
}

module.exports = {
    DesktopCapture,
    DesktopCaptureError,
    COMMANDS,
    IMAGE_TYPES,
    IMAGE_TYPE_FORMATS,
    MIME_TYPES,
    MOUSE_BUTTONS,
    KEY_ACTIONS,
    KEYCODE_TABLE,
    KEY_NAMES,
    encodeCommand,
    encodeCompressionLevel,
    encodePause,
    encodeRefresh,
    encodeGetDisplays,
    encodeSetDisplay,
    encodeRemoteInputLock,
    encodeMouseMove,
    encodeMouseButton,
    encodeMouseScroll,
    encodeKey,
    encodeKeyUnicode,
    encodeText,
    keycodeFromName,
    scaleCoordinates,
    decodeCommand,
    parseMessage,
    detectImageFormat,
    readImageDimensions,
    normalizeRelayUrl
};
