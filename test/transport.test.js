// -----------------------------------------------------------------------------
// The REAL transport (src/mqtt.js: guarded socket, mqtt.js client, MQTT 5
// then 3.1.1) against a real MQTT broker on 127.0.0.1 (test/helpers/broker.js),
// on the real clock, short reconnection period. Every wait is bounded; the
// app, the broker and the servers are closed in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TeslaMateApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { MAX_PACKET, connectBroker } from '../src/mqtt.js';
import { memoryStore } from '../src/store.js';
import { broker } from './helpers/broker.js';
import { F, SELECTOR, createdCar, memoryLogger } from './helpers/app.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, what, ms = 5000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error(`never: ${what}`);
}

async function launch(t, { port, config = {}, devices = [] } = {}) {
  const logger = memoryLogger();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { broker_url: `127.0.0.1:${port}`, ...config },
    devices,
    logger,
  });
  const store = memoryStore();
  const app = new TeslaMateApp({
    gladys,
    logger,
    store,
    connect: (c, o) => connectBroker(c, { ...o, reconnectPeriod: 200, connectTimeout: 2000 }),
  });
  t.after(() => app.stop());
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  const status = () => gladys.fake.connectionStatus?.message?.en ?? '';
  return { gladys, app, store, logger, status };
}

async function started(t, options) {
  const b = broker(options);
  await b.listen();
  t.after(() => b.close());
  return b;
}

test('transport: MQTT 5 asks for 64 KB at most; a packet announced at 100 MB is cut at once', async (t) => {
  const b = await started(t);
  const device = createdCar({ features: ['battery_level'] });
  const a = await launch(t, { port: b.port, devices: [device] });
  await waitFor(() => b.subs.length === 1, 'subscribed');
  assert.equal(b.connectLog[0].version, 5);
  assert.equal(b.connectLog[0].maxPacket, MAX_PACKET);
  const [c] = b.conns;
  const topic = Buffer.from('teslamate/cars/1/battery_level');
  const length = [];
  for (let x = 100 * 1024 * 1024; x > 0; x = Math.floor(x / 128)) {
    length.push((x % 128) | (x >= 128 ? 128 : 0));
  }
  const t0 = performance.now();
  let closedAfter;
  c.sock.on('close', () => {
    closedAfter = performance.now() - t0;
  });
  c.sock.write(Buffer.concat([Buffer.from([0x30, ...length, 0, topic.length]), topic]));
  for (let i = 0; i < 50 && closedAfter === undefined; i += 1) {
    c.sock.write(Buffer.alloc(64 * 1024, 0x35));
    await sleep(5);
  }
  await waitFor(() => closedAfter !== undefined, 'the connection cut');
  assert.ok(closedAfter < 1000, `cut after ${Math.round(closedAfter)} ms`);
  // Reconnected, then a normal value is read.
  await waitFor(() => b.connects >= 2 && b.conns.size === 1 && b.subs.length >= 2, 'reconnected');
  b.publish('teslamate/cars/1/battery_level', '61');
  await waitFor(() => a.gladys.fake.lastState(F('battery_level')) === 61, 'the value read');
});

for (const [name, options] of [
  ['MQTT 5 reason 135', { mode: 'refuse', refuseCode: 5 }],
  ['MQTT 5 reason 138 (banned)', { mode: 'refuse', refuseCode: 138 }],
  ['MQTT 3.1.1 return code 5', { mode: 'v3only', auth: { username: 'u', password: 'right' } }],
]) {
  test(`transport: ${name} stops the client, no new try`, async (t) => {
    const b = await started(t, options);
    const a = await launch(t, { port: b.port, config: { username: 'u', password: 'wrong' } });
    await waitFor(() => /refused/.test(a.status()), 'refused');
    const connects = b.connects;
    await sleep(800);
    assert.equal(b.connects, connects, 'no new try');
    assert.equal(a.store.data.auth.failures, 1);
  });
}

test('transport: a CONNECT closed once, then accepted: no stop', async (t) => {
  const b = await started(t, { mode: 'closeAfterConnect', times: 1 });
  const a = await launch(t, { port: b.port, config: { username: 'u', password: 'p' } });
  await waitFor(() => b.subs.length === 1, 'subscribed after the second CONNECT');
  assert.equal(a.app.memory.auth.failures, 0);
  assert.doesNotMatch(a.status(), /refused/);
});

test('transport: "server unavailable" (136) is tried again, not a stop', async (t) => {
  const b = await started(t, { mode: 'refuse', refuseCode: 136, times: 2 });
  const a = await launch(t, { port: b.port });
  await waitFor(() => b.subs.length === 1, 'subscribed after the refusals');
  assert.equal(a.app.memory.auth.failures, 0);
});

test('transport: a 3.1.1 broker is used in 3.1.1, said in the status', async (t) => {
  const b = await started(t, { mode: 'v3only' });
  const a = await launch(t, { port: b.port });
  await waitFor(() => b.subs.length === 1, 'subscribed');
  assert.deepEqual(
    b.connectLog.map((l) => l.version),
    [5, 4],
  );
  b.publish('teslamate/cars/1/battery_level', '50', { retain: true });
  await waitFor(() => /MQTT 3\.1\.1/.test(a.status()), 'status');
});

test('transport: TLS with a self-signed certificate: nothing leaves unless allowed', async (t) => {
  const key = readFileSync(new URL('./fixtures/device.key', import.meta.url));
  const cert = readFileSync(new URL('./fixtures/device.crt', import.meta.url));
  let bytes = 0;
  const server = tls.createServer({ key, cert }, (s) => {
    s.on('data', (d) => {
      bytes += d.length;
    });
    s.on('error', () => {});
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const config = { broker_url: `mqtts://127.0.0.1:${port}`, username: 'u', password: 'PW-1' };
  const a = await launch(t, { port, config });
  await waitFor(() => /unreachable/.test(a.status()), 'refused certificate');
  await sleep(500);
  assert.equal(bytes, 0, 'verified: the password never left');
  a.app.stop();
  const b = await launch(t, { port, config: { ...config, verify_certificate: false } });
  await waitFor(() => bytes > 0, 'not verified (the user chose it): the CONNECT leaves');
  b.app.stop();
});
