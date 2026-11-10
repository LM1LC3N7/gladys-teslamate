// -----------------------------------------------------------------------------
// The pure parts: configuration, topics and payloads, the MQTT size guard,
// the publisher budget, the /data memory.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURES, parseSince, parseTopic, roundedPosition, strictNumber } from '../src/car.js';
import { normalizeConfig, parseBrokerUrl, parseNamespace, topicPrefix } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { age } from '../src/i18n.js';
import { MAX_PACKET, PacketGuard, errorReason, isRefusal } from '../src/mqtt.js';
import { StatePublisher } from '../src/publisher.js';
import { authWait, fileStore, normalizeMemory } from '../src/store.js';
import { testClock } from './helpers/clock.js';

test('broker address: completed, bounded, never credentials inside', () => {
  assert.deepEqual(parseBrokerUrl('192.168.1.20'), {
    url: 'mqtt://192.168.1.20',
    host: '192.168.1.20',
    port: 1883,
    tls: false,
  });
  assert.equal(parseBrokerUrl('mqtts://broker.lan').port, 8883);
  assert.equal(parseBrokerUrl('mqtt://[fd00::1]:1884').host, 'fd00::1');
  assert.equal(parseBrokerUrl('ssl://b:8884').tls, true);
  for (const [raw, error] of [
    ['', 'empty'],
    [undefined, 'empty'],
    ['http://b', 'invalid'],
    ['ws://b', 'invalid'],
    ['mqtt://b/path', 'invalid'],
    ['mqtt://u:p@b', 'credentials'],
    ['0.0.0.0', 'invalid'],
    ['224.0.0.1', 'invalid'],
    ['255.255.255.255', 'invalid'],
    ['b\r\nc', 'invalid'],
    ['x'.repeat(301), 'invalid'],
  ]) {
    assert.equal(parseBrokerUrl(raw).error, error, String(raw));
  }
});

test('namespace: one safe topic level, never a wildcard nor "default"', () => {
  assert.deepEqual(parseNamespace(''), { namespace: undefined });
  assert.deepEqual(parseNamespace(' account_0 '), { namespace: 'account_0' });
  for (const bad of ['a/b', '+', '#', 'a.b', '..', 'a b', 'a:b', 'default', 'x'.repeat(65), 'é']) {
    assert.equal(parseNamespace(bad).error, 'namespace', bad);
  }
  assert.equal(topicPrefix(normalizeConfig({ broker_url: 'b' })), 'teslamate/cars/');
  assert.equal(
    topicPrefix(normalizeConfig({ broker_url: 'b', namespace: 'n1' })),
    'teslamate/n1/cars/',
  );
});

test('configuration: safe defaults, strict booleans, no password without user', () => {
  const c = normalizeConfig({ broker_url: 'b' });
  assert.equal(c.publishPosition, false);
  assert.equal(c.publishGeofence, true);
  assert.equal(c.verifyCertificate, true);
  assert.equal(normalizeConfig({ broker_url: 'b', publish_position: 1 }).publishPosition, false);
  assert.equal(
    normalizeConfig({ broker_url: 'b', publish_position: 'true' }).publishPosition,
    true,
  );
  assert.equal(normalizeConfig({ broker_url: 'b', publish_geofence: 0 }).publishGeofence, true);
  assert.equal(
    normalizeConfig({ broker_url: 'b', password: 'p' }).problem,
    'password_without_user',
  );
  assert.equal(
    normalizeConfig({ broker_url: 'b', username: 'u', password: 'p\n' }).problem,
    'control',
  );
  assert.equal(normalizeConfig(null).problem, 'empty');
});

test('topics: a car id from 1, one level after it, nothing else', () => {
  const p = 'teslamate/cars/';
  assert.deepEqual(parseTopic('teslamate/cars/1/battery_level', p), {
    carId: '1',
    suffix: 'battery_level',
  });
  for (const topic of [
    'teslamate/cars/0/state',
    'teslamate/cars/01/state',
    'teslamate/cars/1234567/state',
    'teslamate/cars/1/state/x',
    'teslamate/cars/1/',
    'teslamate/cars/1/State',
    'teslamate/other/cars/1/state',
    'teslamate/cars/-1/state',
  ]) {
    assert.equal(parseTopic(topic, p), undefined, topic);
  }
});

test('numbers: strict, never "" read as 0', () => {
  assert.equal(strictNumber('2.05'), 2.05);
  assert.equal(strictNumber('-9'), -9);
  for (const bad of ['', ' ', '1e3', '0x10', ' 1', '1 ', '1,5', 'Infinity', '.5', '5.']) {
    assert.equal(strictNumber(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(FEATURES.tyre_front_left.parse('2.875'), { state: 2.88 });
  assert.equal(FEATURES.tyre_front_left.parse('11'), undefined);
  assert.deepEqual(FEATURES.charger_power.parse('48.9'), { state: 48.9 });
  assert.equal(FEATURES.charger_power.parse('-1'), undefined);
  assert.deepEqual(FEATURES.outside_temperature.parse('-12.5'), { state: -12.5 });
  assert.equal(FEATURES.battery_level.parse('88.0'), undefined, 'an integer, never a decimal');
  assert.deepEqual(FEATURES.locked.parse('true'), { state: 1 });
  assert.equal(FEATURES.locked.parse('True'), undefined);
  assert.equal(FEATURES.state.parse('a b'), undefined);
  assert.equal(FEATURES.geofence.parse('Home\u0000'), undefined);
  assert.equal(FEATURES.geofence.parse('x'.repeat(101)), undefined);
});

test('position: rounded to 3 decimals, invalid shapes refused', () => {
  assert.deepEqual(roundedPosition('{"latitude":35.278131,"longitude":29.744801}'), {
    text: '35.278, 29.745',
  });
  assert.deepEqual(roundedPosition('{"latitude":-0.0001,"longitude":-0.0004}'), {
    text: '0.000, 0.000',
  });
  for (const bad of [
    '',
    'nil',
    '{',
    '[]',
    '{"latitude":"1","longitude":2}',
    '{"latitude":91,"longitude":2}',
    '{"latitude":1,"longitude":181}',
    '{"latitude":0,"longitude":0}',
    `{"latitude":1,"longitude":2,"x":"${'a'.repeat(600)}"}`,
    '{"__proto__":{"latitude":1,"longitude":2}}',
  ]) {
    assert.equal(roundedPosition(bad), undefined, bad.slice(0, 40));
  }
});

test('since: an ISO date only', () => {
  assert.equal(parseSince('2019-02-28T23:00:07Z'), Date.UTC(2019, 1, 28, 23, 0, 7));
  assert.equal(parseSince('2019-02-28T23:00:07.123+01:00'), Date.UTC(2019, 1, 28, 22, 0, 7, 123));
  for (const bad of ['', 'yesterday', '1700000000', '2019-02-28', '2019-02-28T23:00:07']) {
    assert.equal(parseSince(bad), undefined, bad);
  }
});

test('PacketGuard: a packet announced over the limit cuts before it is read', async () => {
  const guard = new PacketGuard(1024);
  const out = [];
  guard.on('data', (c) => out.push(c));
  const errors = [];
  guard.on('error', (e) => errors.push(e));
  // A small PUBLISH, then a header announcing 2 MB: the small one passes, then the cut.
  const small = Buffer.from([0x30, 0x03, 0x00, 0x01, 0x61]);
  const big = Buffer.from([0x30, 0x80, 0x80, 0x80, 0x01]);
  guard.write(Buffer.concat([small, big]));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(Buffer.concat(out), small);
  assert.equal(errors[0]?.code, 'PACKET_TOO_LARGE');
  assert.equal(MAX_PACKET, 64 * 1024);
});

test('PacketGuard: split headers and bodies are followed across chunks', async () => {
  const guard = new PacketGuard(1024);
  const out = [];
  guard.on('data', (c) => out.push(c));
  const errors = [];
  guard.on('error', (e) => errors.push(e));
  const body = Buffer.alloc(200, 1);
  const packet = Buffer.concat([Buffer.from([0x30, 0xc8, 0x01]), body]);
  for (let i = 0; i < packet.length; i += 7) {
    guard.write(packet.subarray(i, i + 7));
  }
  guard.write(Buffer.from([0x30, 0xff]));
  guard.write(Buffer.from([0xff, 0xff, 0xff]));
  await new Promise((r) => setImmediate(r));
  assert.equal(Buffer.concat(out).length, packet.length + 2);
  assert.equal(errors[0]?.code, 'PACKET_TOO_LARGE', 'malformed length');
});

test('errors: readable, never a password', () => {
  assert.equal(errorReason({ code: 5 }), 'not authorized');
  assert.equal(errorReason({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(
    errorReason(new Error('connect mqtt://user:S3cret@host failed')),
    'connect mqtt://host failed',
  );
  assert.ok(isRefusal({ code: 4 }) && isRefusal({ code: 135 }) && !isRefusal({ code: 3 }));
});

test('publisher: budget per minute and spacing on the monotonic clock', async () => {
  const clock = testClock();
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const p = new StatePublisher({
    gladys,
    logger: console,
    monotonic: clock.monotonic,
    timers: clock.timers,
    budget: 5,
  });
  p.start();
  for (let i = 0; i < 10; i += 1) {
    p.push(`f${i}`, { state: i });
  }
  await clock.advance(1000);
  assert.equal(sent.length, 5, 'the budget');
  await clock.advance(30_000);
  assert.equal(sent.length, 5, 'still within the minute');
  await clock.advance(31_000);
  assert.equal(sent.length, 10);
  // A measurement: at most one per measurementInterval (once the minute is over).
  await clock.advance(61_000);
  p.push('m', { state: 1 }, { throttle: true });
  await clock.advance(1000);
  p.push('m', { state: 2 }, { throttle: true });
  await clock.advance(1000);
  assert.equal(sent.filter((s) => s.device_feature_external_id === 'm').length, 1);
  await clock.advance(TIMINGS.measurementInterval);
  assert.equal(sent.filter((s) => s.device_feature_external_id === 'm').length, 2);
  p.stop();
  assert.equal(clock.pending, 0);
});

test('publisher: a failed send keeps the values and counts in the budget', async () => {
  const clock = testClock();
  let fail = true;
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      if (fail) {
        throw new Error('429');
      }
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const p = new StatePublisher({
    gladys,
    logger: { warn() {} },
    monotonic: clock.monotonic,
    timers: clock.timers,
    budget: 3,
  });
  p.push('a', { state: 1 });
  p.push('b', { state: 1 });
  await p.flush().catch(() => {});
  fail = false;
  p.push('a', { state: 2 });
  await p.flush();
  assert.deepEqual(
    sent.map((s) => [s.device_feature_external_id, s.state]),
    [['a', 2]],
    'the newer value wins, the budget counted the failed batch',
  );
});

test('memory: bounded, never a secret, unknown keys dropped', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.deepEqual(normalizeMemory(null, now), { auth: { failures: 0, until: 0 } });
  const m = normalizeMemory(
    { auth: { failures: 3, until: now + 365 * 86400_000 }, password: 'x' },
    now,
  );
  assert.equal(m.auth.until, now + TIMINGS.authRetry.at(-1), 'capped');
  assert.equal(normalizeMemory({ auth: { failures: 2, until: now - 1 } }, now).auth.until, 0);
  assert.equal(
    normalizeMemory(JSON.parse('{"__proto__":{"auth":{"failures":9}}}'), now).auth.failures,
    0,
  );
  assert.equal(authWait(1), 15 * 60_000);
  assert.equal(authWait(99), 24 * 3600_000);
});

test('file store: 0600, atomic, a broken file is read as nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'teslamate-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ auth: { failures: 1, until: 5 } });
  assert.deepEqual(await store.load(), { auth: { failures: 1, until: 5 } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{broken');
  assert.equal(await store.load(), null);
});

test('age: seconds, minutes, hours', () => {
  assert.equal(age(5000), '5 s');
  assert.equal(age(15 * 60_000), '15 min');
  assert.equal(age(3600_000), '1 h');
  assert.equal(age(24 * 3600_000), '24 h');
});
