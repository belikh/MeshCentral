'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const {
  DesktopCapture,
  DesktopCaptureError,
  COMMANDS,
  encodeCompressionLevel,
  encodePause,
  encodeRefresh
} = require('../desktopcapture');

// Synthetic fixtures only: a header-only JPEG with a 1920x1080 SOF0 marker, a
// made-up node id and a made-up tunnel id. Nothing here comes from a real system.
const TINY_JPEG = Buffer.from([
  0xFF, 0xD8,
  0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xFF, 0xC0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xFF, 0xD9
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

function alertCommand(text) {
  const body = Buffer.from(text, 'utf8');
  const buffer = Buffer.alloc(4 + body.length);
  buffer.writeUInt16BE(COMMANDS.ERROR, 0);
  buffer.writeUInt16BE(buffer.length, 2);
  body.copy(buffer, 4);
  return buffer;
}

function relayUrl(port, query) {
  const base = `ws://127.0.0.1:${port}/meshrelay.ashx?p=2&id=tunnel-sanitised&nodeid=node/example/device&auth=test-token`;
  return query == null ? base : base + '&' + query;
}

async function startRelay(onConnection) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  wss.on('connection', onConnection);
  return { wss, port: wss.address().port };
}

async function stopRelay(wss) {
  for (const client of wss.clients) { try { client.terminate(); } catch (ex) { } }
  await new Promise((resolve) => wss.close(resolve));
}

function collectMessages(socket, received = []) {
  socket.on('message', (data, isBinary) => { received.push({ data: Buffer.from(data), isBinary }); });
  return received;
}

async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for condition'); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('session: connects, negotiates in browser order and yields a frame', async (t) => {
  const received = [];
  const { wss, port } = await startRelay((socket) => {
    socket.on('message', (data, isBinary) => {
      received.push({ data: Buffer.from(data), isBinary });
      if (!isBinary && data.toString() === '2') {
        socket.send(screenCommand(1920, 1080));
        socket.send(pictureCommand(0, 0, TINY_JPEG));
      }
    });
    socket.send('c');
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  const states = [];
  capture.on('state', (state) => states.push(state));
  const frameEvent = once(capture, 'frame');
  await capture.start();
  assert.equal(capture.state, 'connected');
  assert.equal(capture.isConnected(), true);

  const frame = await capture.waitForFrame({ latest: true, timeout: 2000 });
  assert.equal((await frameEvent)[0], frame);
  assert.equal(frame.type, 'frame');
  assert.equal(frame.index, 1);
  assert.equal(frame.format, 'jpeg');
  assert.equal(frame.mimeType, 'image/jpeg');
  assert.equal(frame.imageType, 1);
  assert.equal(frame.length, TINY_JPEG.length);
  assert.deepEqual(frame.data, TINY_JPEG);
  assert.equal(frame.x, 0);
  assert.equal(frame.y, 0);
  assert.equal(frame.width, 1920);
  assert.equal(frame.height, 1080);
  assert.deepEqual(frame.screen, { width: 1920, height: 1080 });
  assert.equal(typeof frame.timestamp, 'number');
  assert.equal(capture.getLatestFrame(), frame);
  assert.deepEqual(capture.getScreenSize(), { width: 1920, height: 1080 });

  await until(() => received.filter((entry) => entry.isBinary).length >= 3);
  const texts = received.filter((entry) => !entry.isBinary).map((entry) => entry.data.toString());
  assert.deepEqual(texts, ['{"type":"options"}', '2']);
  const binaries = received.filter((entry) => entry.isBinary).map((entry) => entry.data);
  assert.deepEqual(binaries[0], encodeCompressionLevel({ imageType: 1, compression: 50, scaling: 1024, frameRate: 100 }));
  assert.deepEqual(binaries[1], encodePause(false));
  assert.deepEqual(binaries[2], encodeRefresh());

  await capture.close();
  assert.equal(capture.state, 'closed');
  assert.equal(capture.isConnected(), false);
  assert.deepEqual(states, ['connecting', 'connected', 'closed']);
});

test('session: waitForFrame waits for a frame that arrives after the call', async (t) => {
  let socketRef = null;
  const { wss, port } = await startRelay((socket) => {
    socketRef = socket;
    socket.send('c');
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  await capture.start();
  const pending = capture.waitForFrame({ timeout: 2000 });
  socketRef.send(screenCommand(800, 600));
  socketRef.send(pictureCommand(16, 32, TINY_JPEG));
  const frame = await pending;
  assert.equal(frame.x, 16);
  assert.equal(frame.y, 32);
  assert.deepEqual(frame.screen, { width: 800, height: 600 });
  await capture.close();
});

test('session: start rejects with a timeout when the relay never announces connection', async (t) => {
  const { wss, port } = await startRelay(() => { });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), connectTimeout: 150 });
  await assert.rejects(capture.start(), (error) => {
    assert.equal(error instanceof DesktopCaptureError, true);
    assert.equal(error.code, 'E_TIMEOUT');
    return true;
  });
  assert.equal(capture.state, 'closed');
  await capture.close();
});

test('session: start rejects when the relay closes before the handshake', async (t) => {
  const { wss, port } = await startRelay((socket) => { socket.close(); });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), connectTimeout: 2000 });
  await assert.rejects(capture.start(), (error) => {
    assert.equal(error instanceof DesktopCaptureError, true);
    assert.equal(error.code, 'E_HANDSHAKE');
    return true;
  });
  await capture.close();
});

test('session: per-wait timeout does not kill the session and a later frame resolves', async (t) => {
  let socketRef = null;
  const { wss, port } = await startRelay((socket) => {
    socketRef = socket;
    socket.send('c');
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 5000 });
  await capture.start();
  await assert.rejects(capture.waitForFrame({ timeout: 100 }), (error) => {
    assert.equal(error.code, 'E_TIMEOUT');
    return true;
  });
  assert.equal(capture.state, 'connected');
  const pending = capture.waitForFrame({ timeout: 2000 });
  socketRef.send(pictureCommand(0, 0, TINY_JPEG));
  const frame = await pending;
  assert.equal(frame.format, 'jpeg');
  await capture.close();
});

test('session: server denial text is surfaced verbatim when the relay closes', async (t) => {
  const { wss, port } = await startRelay((socket) => {
    socket.send('c');
    socket.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === '2') {
        socket.send(alertCommand('Consent declined by user'));
        socket.close(1008, 'consent');
      }
    });
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  const errorEvent = once(capture, 'error');
  await capture.start();
  const pending = capture.waitForFrame({ timeout: 2000 });
  const [error] = await errorEvent;
  assert.equal(error.code, 'E_CLOSED');
  assert.equal(error.serverMessage, 'Consent declined by user');
  await assert.rejects(pending, (rejection) => {
    assert.equal(rejection.code, 'E_CLOSED');
    assert.equal(rejection.serverMessage, 'Consent declined by user');
    return true;
  });
  await capture.close();
});

test('session: waiting after close rejects and close is idempotent', async (t) => {
  const { wss, port } = await startRelay((socket) => { socket.send('c'); });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  await capture.start();
  await capture.close();
  await capture.close();
  await assert.rejects(capture.waitForFrame({ timeout: 100 }), (error) => {
    assert.equal(error.code, 'E_CLOSED');
    return true;
  });
});

test('session: close sends the control close message to the relay', async (t) => {
  let received = null;
  const { wss, port } = await startRelay((socket) => {
    received = collectMessages(socket);
    socket.send('c');
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  await capture.start();
  await capture.close();
  await until(() => received.some((entry) => !entry.isBinary && entry.data.toString().indexOf('"type":"close"') >= 0));
  const closeMessage = received.find((entry) => !entry.isBinary && entry.data.toString().indexOf('"type":"close"') >= 0);
  const parsed = JSON.parse(closeMessage.data.toString());
  assert.equal(parsed.ctrlChannel, '102938');
  assert.equal(parsed.type, 'close');
});

test('session: constructor normalises the relay url and validates config', () => {
  const capture = new DesktopCapture({ url: 'https://mesh.example/meshrelay.ashx?p=2&nodeid=node/example/device' });
  assert.equal(capture.url.startsWith('wss://mesh.example/meshrelay.ashx'), true);
  assert.equal(new URL(capture.url).searchParams.get('browser'), '1');
  assert.equal(new URL(capture.url).searchParams.get('p'), '2');

  const plain = new DesktopCapture({ url: 'ws://mesh.example/meshrelay.ashx?p=2' });
  assert.equal(new URL(plain.url).searchParams.get('browser'), '1');

  assert.throws(() => new DesktopCapture({}), /relay/i);
  assert.throws(() => new DesktopCapture({ url: 'ftp://mesh.example/relay' }), /ws/i);
  assert.throws(() => new DesktopCapture({ url: 'ws://mesh.example/relay', imageType: 9 }), /image/i);
});

test('session: setEncoding renegotiates compression on the open session', async (t) => {
  const received = [];
  const { wss, port } = await startRelay((socket) => {
    collectMessages(socket, received);
    socket.send('c');
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  await capture.start();
  await until(() => received.filter((entry) => entry.isBinary).length >= 3);
  received.length = 0;
  capture.setEncoding({ imageType: 3, compression: 10, scaling: 256, frameRate: 500 });
  await until(() => received.some((entry) => entry.isBinary));
  const command = received.find((entry) => entry.isBinary).data;
  assert.deepEqual(command, encodeCompressionLevel({ imageType: 3, compression: 10, scaling: 256, frameRate: 500 }));
  await capture.close();
});

test('session: a screen-size change triggers renegotiation like the browser viewer', async (t) => {
  let socketRef = null;
  const received = [];
  const { wss, port } = await startRelay((socket) => {
    socketRef = socket;
    collectMessages(socket, received);
    socket.send('c');
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  await capture.start();
  await until(() => received.filter((entry) => entry.isBinary).length >= 3);
  const screenEvent = once(capture, 'screen');
  received.length = 0;
  socketRef.send(screenCommand(1280, 720));
  assert.deepEqual(await screenEvent, [{ width: 1280, height: 720 }]);
  assert.deepEqual(capture.getScreenSize(), { width: 1280, height: 720 });
  await until(() => received.filter((entry) => entry.isBinary).length >= 2);
  const binaries = received.filter((entry) => entry.isBinary).map((entry) => entry.data);
  assert.deepEqual(binaries[0], encodeCompressionLevel({ imageType: 1, compression: 50, scaling: 1024, frameRate: 100 }));
  assert.deepEqual(binaries[1], encodePause(false));
  await capture.close();
});

test('session: relay control-channel pings are answered with pong', async (t) => {
  const received = [];
  const { wss, port } = await startRelay((socket) => {
    collectMessages(socket, received);
    socket.send('c');
    socket.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === '2') {
        socket.send(JSON.stringify({ ctrlChannel: '102938', type: 'ping' }));
      }
    });
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), timeout: 2000 });
  await capture.start();
  await until(() => received.some((entry) => !entry.isBinary && entry.data.toString() === '{"ctrlChannel":"102938","type":"pong"}'));
  await capture.close();
});

test('session: options are sent before the protocol start when configured', async (t) => {
  const received = [];
  const { wss, port } = await startRelay((socket) => {
    collectMessages(socket, received);
    socket.send('c');
  });
  t.after(() => stopRelay(wss));

  const capture = new DesktopCapture({ url: relayUrl(port), options: { consent: 4 }, timeout: 2000 });
  await capture.start();
  await until(() => received.some((entry) => !entry.isBinary && entry.data.toString() === '2'));
  const texts = received.filter((entry) => !entry.isBinary).map((entry) => entry.data.toString());
  assert.deepEqual(texts, ['{"consent":4,"type":"options"}', '2']);
  await capture.close();
});
