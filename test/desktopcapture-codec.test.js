'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMMANDS,
  encodeCommand,
  encodeCompressionLevel,
  encodePause,
  encodeRefresh,
  decodeCommand,
  parseMessage,
  detectImageFormat,
  readImageDimensions
} = require('../desktopcapture');

// Every fixture in this file is synthetic. The JPEG is a header-only image with
// a 1920x1080 SOF0 marker; no real screenshot, token, node id or domain appears.
const TINY_JPEG = Buffer.from([
  0xFF, 0xD8,
  0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xFF, 0xC0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xFF, 0xD9
]);

const PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x07, 0x80, 0x00, 0x00, 0x04, 0x38
]);

function pictureCommand(x, y, image) {
  const buffer = Buffer.alloc(8 + image.length);
  buffer.writeUInt16BE(COMMANDS.PICTURE, 0);
  buffer.writeUInt16BE(buffer.length, 2);
  buffer.writeUInt16BE(x, 4);
  buffer.writeUInt16BE(y, 6);
  image.copy(buffer, 8);
  return buffer;
}

function screenCommand(width, height) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt16BE(COMMANDS.SCREEN, 0);
  buffer.writeUInt16BE(8, 2);
  buffer.writeUInt16BE(width, 4);
  buffer.writeUInt16BE(height, 6);
  return buffer;
}

function asciiCommand(command, text) {
  const body = Buffer.from(text, 'utf8');
  const buffer = Buffer.alloc(4 + body.length);
  buffer.writeUInt16BE(command, 0);
  buffer.writeUInt16BE(buffer.length, 2);
  body.copy(buffer, 4);
  return buffer;
}

function jumboCommand(inner) {
  const buffer = Buffer.alloc(8 + inner.length);
  buffer.writeUInt16BE(COMMANDS.JUMBO, 0);
  buffer.writeUInt16BE(8, 2);
  buffer.writeUInt32BE(inner.length, 4);
  inner.copy(buffer, 8);
  return buffer;
}

function tiffFixture(littleEndian, width, height) {
  const buffer = Buffer.alloc(38);
  if (littleEndian) {
    buffer.write('II', 0, 'latin1');
    buffer.writeUInt16LE(42, 2);
    buffer.writeUInt32LE(8, 4);
  } else {
    buffer.write('MM', 0, 'latin1');
    buffer.writeUInt16BE(42, 2);
    buffer.writeUInt32BE(8, 4);
  }
  const w16 = (value, offset) => littleEndian ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt16BE(value, offset);
  const w32 = (value, offset) => littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  w16(2, 8);
  w16(0x0100, 10); w16(3, 12); w32(1, 14); w16(width, 18); w32(0, 18 + 2);
  w16(0x0101, 22); w16(3, 24); w32(1, 26); w16(height, 30); w32(0, 30 + 2);
  w32(0, 34);
  return buffer;
}

function webpFixture(fourcc, width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write(fourcc, 12, 'latin1');
  if (fourcc === 'VP8X') {
    buffer.writeUIntLE(width - 1, 24, 3);
    buffer.writeUIntLE(height - 1, 27, 3);
  } else if (fourcc === 'VP8 ') {
    buffer[23] = 0x9D; buffer[24] = 0x01; buffer[25] = 0x2A;
    buffer.writeUInt16LE(width, 26);
    buffer.writeUInt16LE(height, 28);
  }
  return buffer;
}

function webpLosslessFixture(width, height) {
  const buffer = Buffer.alloc(25);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8L', 12, 'latin1');
  buffer.writeUInt32LE(5, 16);
  buffer[20] = 0x2F;
  const encoded = ((width - 1) & 0x3FFF) | (((height - 1) & 0x3FFF) << 14);
  buffer[21] = encoded & 0xFF;
  buffer[22] = (encoded >> 8) & 0xFF;
  buffer[23] = (encoded >> 16) & 0xFF;
  buffer[24] = (encoded >> 24) & 0x0F;
  return buffer;
}

test('codec: compression negotiation bytes match the browser encoder', () => {
  assert.deepEqual(
    encodeCompressionLevel({ imageType: 2, compression: 40, scaling: 512, frameRate: 250 }),
    Buffer.from([0x00, 0x05, 0x00, 0x0A, 0x02, 0x28, 0x02, 0x00, 0x00, 0xFA])
  );
});

test('codec: pause, unpause and refresh bytes match the browser encoder', () => {
  assert.deepEqual(encodePause(true), Buffer.from([0x00, 0x08, 0x00, 0x05, 0x01]));
  assert.deepEqual(encodePause(false), Buffer.from([0x00, 0x08, 0x00, 0x05, 0x00]));
  assert.deepEqual(encodeRefresh(), Buffer.from([0x00, 0x06, 0x00, 0x04]));
});

test('codec: generic command header carries a big-endian command and total size', () => {
  const command = encodeCommand(0x0102, Buffer.from([0xAA, 0xBB]));
  assert.deepEqual(command, Buffer.from([0x01, 0x02, 0x00, 0x06, 0xAA, 0xBB]));
});

test('codec: screen-size announcement parses width and height', () => {
  assert.deepEqual(parseMessage(screenCommand(1920, 1080)), { type: 'screen', width: 1920, height: 1080 });
});

test('codec: picture frame parses tile origin, image bytes, format and dimensions', () => {
  const parsed = parseMessage(pictureCommand(32, 48, TINY_JPEG));
  assert.equal(parsed.type, 'frame');
  assert.equal(parsed.x, 32);
  assert.equal(parsed.y, 48);
  assert.equal(parsed.format, 'jpeg');
  assert.equal(parsed.mimeType, 'image/jpeg');
  assert.equal(parsed.width, 1920);
  assert.equal(parsed.height, 1080);
  assert.equal(parsed.data.length, TINY_JPEG.length);
  assert.deepEqual(parsed.data, TINY_JPEG);
});

test('codec: jumbo-wrapped picture frame unwraps to the inner command', () => {
  const inner = pictureCommand(16, 16, TINY_JPEG);
  const parsed = parseMessage(jumboCommand(inner));
  assert.equal(parsed.type, 'frame');
  assert.equal(parsed.x, 16);
  assert.equal(parsed.y, 16);
  assert.equal(parsed.format, 'jpeg');
  assert.deepEqual(parsed.data, TINY_JPEG);
});

test('codec: incomplete command is reported, not parsed', () => {
  const full = pictureCommand(0, 0, TINY_JPEG);
  const partial = full.subarray(0, 12);
  const decoded = decodeCommand(partial);
  assert.equal(decoded.incomplete, true);
  assert.equal(decoded.command, COMMANDS.PICTURE);
  assert.equal(parseMessage(partial), null);
});

test('codec: copy-rect parses source, destination and size', () => {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt16BE(COMMANDS.COPY, 0);
  buffer.writeUInt16BE(16, 2);
  buffer.writeUInt16BE(1, 4); buffer.writeUInt16BE(2, 6);
  buffer.writeUInt16BE(3, 8); buffer.writeUInt16BE(4, 10);
  buffer.writeUInt16BE(5, 12); buffer.writeUInt16BE(6, 14);
  assert.deepEqual(parseMessage(buffer), {
    type: 'copy', sourceX: 1, sourceY: 2, destX: 3, destY: 4, width: 5, height: 6
  });
});

test('codec: display list parses counts, ids and selection', () => {
  const buffer = Buffer.from([0x00, 0x0B, 0x00, 0x0C, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]);
  assert.deepEqual(parseMessage(buffer), { type: 'displays', count: 2, displays: [0, 1], selected: 1 });
});

test('codec: display location info parses each 10-byte record', () => {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt16BE(COMMANDS.DISPLAY_INFO, 0);
  buffer.writeUInt16BE(14, 2);
  buffer.writeUInt16BE(7, 4); buffer.writeUInt16BE(10, 6); buffer.writeUInt16BE(20, 8);
  buffer.writeUInt16BE(1280, 10); buffer.writeUInt16BE(1024, 12);
  assert.deepEqual(parseMessage(buffer), {
    type: 'displayinfo',
    displays: [{ id: 7, x: 10, y: 20, width: 1280, height: 1024 }]
  });
});

test('codec: keystate, input lock and mouse cursor parse a single byte', () => {
  const keystate = parseMessage(Buffer.from([0x00, 0x12, 0x00, 0x05, 0x05]));
  assert.deepEqual(keystate, { type: 'keystate', state: 5 });
  const inputLock = parseMessage(Buffer.from([0x00, 0x57, 0x00, 0x05, 0x01]));
  assert.deepEqual(inputLock, { type: 'inputlock', locked: true });
  const cursor = parseMessage(Buffer.from([0x00, 0x58, 0x00, 0x05, 0x09]));
  assert.deepEqual(cursor, { type: 'cursor', cursor: 9 });
});

test('codec: alert, message and consent payloads are preserved verbatim', () => {
  const alert = parseMessage(asciiCommand(COMMANDS.ERROR, 'Consent declined by user'));
  assert.deepEqual(alert, { type: 'alert', message: 'Consent declined by user' });
  const message = parseMessage(asciiCommand(COMMANDS.MESSAGE, 'Session notice'));
  assert.deepEqual(message, { type: 'message', message: 'Session notice' });
  const consent = parseMessage(Buffer.from([0x00, 0x3F, 0x00, 0x05, 0x02]));
  assert.equal(consent.type, 'consent');
  assert.equal(consent.state, 2);
});

test('codec: unknown binary commands are surfaced without interpretation', () => {
  const parsed = parseMessage(Buffer.from([0x00, 0x63, 0x00, 0x06, 0x01, 0x02]));
  assert.equal(parsed.type, 'unknown');
  assert.equal(parsed.command, 0x63);
});

test('codec: short or empty buffers do not parse', () => {
  assert.equal(parseMessage(Buffer.alloc(0)), null);
  assert.equal(parseMessage(Buffer.from([0x00, 0x03])), null);
  assert.equal(parseMessage(null), null);
});

test('codec: image format detection reads magic bytes for all four wire formats', () => {
  assert.equal(detectImageFormat(TINY_JPEG), 'jpeg');
  assert.equal(detectImageFormat(PNG), 'png');
  assert.equal(detectImageFormat(tiffFixture(true, 1920, 1080)), 'tiff');
  assert.equal(detectImageFormat(tiffFixture(false, 1920, 1080)), 'tiff');
  assert.equal(detectImageFormat(webpFixture('VP8 ', 1920, 1080)), 'webp');
  assert.equal(detectImageFormat(Buffer.from('not an image')), null);
});

test('codec: PNG dimensions parse from IHDR', () => {
  assert.deepEqual(readImageDimensions(PNG), { width: 1920, height: 1080 });
});

test('codec: TIFF dimensions parse for both byte orders', () => {
  assert.deepEqual(readImageDimensions(tiffFixture(true, 800, 600)), { width: 800, height: 600 });
  assert.deepEqual(readImageDimensions(tiffFixture(false, 800, 600)), { width: 800, height: 600 });
});

test('codec: WebP dimensions parse for lossy, lossless and extended chunks', () => {
  assert.deepEqual(readImageDimensions(webpFixture('VP8 ', 1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(readImageDimensions(webpLosslessFixture(1920, 1080)), { width: 1920, height: 1080 });
  const extended = Buffer.alloc(30);
  extended.write('RIFF', 0, 'latin1');
  extended.writeUInt32LE(22, 4);
  extended.write('WEBP', 8, 'latin1');
  extended.write('VP8X', 12, 'latin1');
  extended.writeUIntLE(1919, 24, 3);
  extended.writeUIntLE(1079, 27, 3);
  assert.deepEqual(readImageDimensions(extended), { width: 1920, height: 1080 });
});

test('codec: truncated images yield no dimensions instead of throwing', () => {
  assert.equal(readImageDimensions(TINY_JPEG.subarray(0, 3)), null);
  assert.equal(readImageDimensions(PNG.subarray(0, 20)), null);
  assert.equal(readImageDimensions(null), null);
});
