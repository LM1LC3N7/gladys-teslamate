// -----------------------------------------------------------------------------
// The app end to end: the SDK's fake Gladys, a fake broker, a virtual clock
// that moves (each read 1 µs, timers fired by advance()).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { testClock } from './helpers/clock.js';
import {
  CONFIG,
  DEVICE,
  F,
  MINUTE,
  PASSWORD,
  SECOND,
  SINCE,
  VIN,
  carTopics,
  createdCar,
  deliverCar,
  settle,
  setup,
  statesOf,
  statusText,
  until,
  within,
} from './helpers/app.js';

const ALL = Object.keys({
  battery_level: 1,
  usable_battery_level: 1,
  rated_range: 1,
  estimated_range: 1,
  charging_state: 1,
  plugged_in: 1,
  charger_power: 1,
  charge_energy_added: 1,
  charge_limit: 1,
  inside_temperature: 1,
  outside_temperature: 1,
  climate_on: 1,
  odometer: 1,
  locked: 1,
  sentry_mode: 1,
  doors_open: 1,
  trunk_open: 1,
  frunk_open: 1,
  windows_open: 1,
  tyre_front_left: 1,
  tyre_front_right: 1,
  tyre_rear_left: 1,
  tyre_rear_right: 1,
  state: 1,
  geofence: 1,
  position: 1,
});

test('Discovery: a car from its retained topics, read only, no VIN, no navigation', async () => {
  const { gladys, mqtt, clock } = await setup();
  assert.deepEqual(mqtt.last.subscriptions, ['teslamate/cars/+/+']);
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE());
  assert.equal(device.name, 'Blue Thunder');
  assert.equal(device.model, 'Tesla Model 3');
  const keys = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys.includes('battery_level'));
  assert.ok(keys.includes('geofence'), 'geofence on by default');
  assert.ok(!keys.includes('position'), 'position off by default');
  assert.ok(device.features.every((f) => f.read_only === true));
  const json = JSON.stringify(gladys.fake.discoveredDevices);
  assert.ok(!json.includes(VIN), 'never the VIN');
  assert.ok(!json.includes('Work') && !json.includes('48.8'), 'never the route nor the position');
  assert.equal(mqtt.last.published.length, 0, 'never publishes on the broker');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // Nothing is sent before the user creates the device.
  assert.equal(gladys.fake.states.length, 0);
});

test('a live value of a created feature is sent now; text never as 0; empty is unknown', async () => {
  const device = createdCar({ features: ALL });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  const c = mqtt.last;
  c.deliver('teslamate/cars/1/battery_level', '77');
  c.deliver('teslamate/cars/1/state', 'charging');
  c.deliver('teslamate/cars/1/doors_open', 'true');
  await clock.advance(1.5 * SECOND);
  assert.equal(gladys.fake.lastState(F('battery_level')), 77);
  assert.equal(gladys.fake.lastState(F('state')), 'charging');
  assert.equal(gladys.fake.lastState(F('doors_open')), 1);
  assert.equal(statesOf(gladys, F('battery_level'))[0].created_at, undefined, 'live = now');
  // Empty, blank, decimals on an integer, out of range, '1e2', ' 5': unknown.
  for (const bad of ['', ' ', '77.5', '101', '-1', '1e2', ' 5', 'nil', 'NaN']) {
    c.deliver('teslamate/cars/1/battery_level', bad);
  }
  c.deliver('teslamate/cars/1/doors_open', '');
  c.deliver('teslamate/cars/1/doors_open', 'yes');
  c.deliver('teslamate/cars/1/state', '');
  c.deliver('teslamate/cars/1/state', 'Ünknown state!');
  await clock.advance(15 * SECOND);
  assert.equal(statesOf(gladys, F('battery_level')).length, 1);
  assert.equal(statesOf(gladys, F('doors_open')).length, 1);
  assert.equal(statesOf(gladys, F('state')).length, 1);
  assert.ok(gladys.fake.states.every((s) => s.state === undefined || Number.isFinite(s.state)));
});

test('charging state mapped like gladys-tesla; geofence empty outside a zone', async () => {
  const device = createdCar({ features: ALL });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  const expected = {
    Charging: 0,
    Starting: 1,
    Stopped: 2,
    NoPower: 3,
    Complete: 4,
    Disconnected: 4,
  };
  for (const [word, value] of Object.entries(expected)) {
    mqtt.last.deliver('teslamate/cars/1/charging_state', word);
    await clock.advance(1.1 * SECOND);
    assert.equal(gladys.fake.lastState(F('charging_state')), value, word);
  }
  mqtt.last.deliver('teslamate/cars/1/charging_state', 'Bogus');
  mqtt.last.deliver('teslamate/cars/1/geofence', '🏡 Home');
  await clock.advance(1.1 * SECOND);
  assert.equal(gladys.fake.lastState(F('charging_state')), 4);
  assert.equal(gladys.fake.lastState(F('geofence')), '🏡 Home');
  mqtt.last.deliver('teslamate/cars/1/geofence', '');
  await clock.advance(1.1 * SECOND);
  assert.equal(gladys.fake.lastState(F('geofence')), '');
});

test('the odometer never goes down', async () => {
  const device = createdCar({
    features: ['odometer'],
    values: { odometer: { value: 1653, at: SINCE } },
  });
  const { gladys, mqtt, clock, logger } = await setup({ devices: [device] });
  mqtt.last.deliver('teslamate/cars/1/odometer', '1600');
  await clock.advance(1.1 * SECOND);
  assert.equal(statesOf(gladys, F('odometer')).length, 0, 'below what Gladys has');
  mqtt.last.deliver('teslamate/cars/1/odometer', '1700.4');
  await clock.advance(1.1 * SECOND);
  assert.equal(gladys.fake.lastState(F('odometer')), 1700.4);
  mqtt.last.deliver('teslamate/cars/1/odometer', '1700.3');
  await clock.advance(11 * SECOND);
  assert.equal(statesOf(gladys, F('odometer')).length, 1);
  assert.ok(logger.lines.some((l) => l.includes('never goes down')));
});

test('retained values: equal to Gladys nothing, newer dated after Gladys, new feature dated at since', async () => {
  const at = '2026-02-01T08:00:00.000Z';
  const device = createdCar({
    features: ['battery_level', 'locked', 'state', 'odometer'],
    values: {
      battery_level: { value: 88, at },
      locked: { value: 0, at },
      state: { value: 'asleep', at },
    },
  });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverCar(mqtt.last, carTopics({ since: '2026-02-20T10:00:00Z' }));
  await clock.advance(3 * SECOND);
  assert.equal(statesOf(gladys, F('battery_level')).length, 0, 'same value: nothing');
  assert.equal(statesOf(gladys, F('state')).length, 0, 'same text: nothing');
  const [locked] = statesOf(gladys, F('locked'));
  assert.equal(locked.state, 1);
  assert.equal(
    locked.created_at,
    '2026-02-01T08:00:00.001Z',
    'just after the last change Gladys knows',
  );
  const [odometer] = statesOf(gladys, F('odometer'));
  assert.equal(odometer.state, 1653);
  assert.equal(odometer.created_at, '2026-02-20T10:00:00.000Z', 'no value yet: at since');
  assert.ok(
    gladys.fake.states.every((s) => s.created_at !== undefined),
    'never as new',
  );
});

test('retained without since: nothing sent until a live value; since in the future capped to now', async () => {
  const device = createdCar({ features: ['battery_level', 'locked'] });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  const topics = carTopics();
  delete topics.since;
  deliverCar(mqtt.last, topics);
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.states.length, 0);
  mqtt.last.deliver('teslamate/cars/1/since', '2099-01-01T00:00:00Z', { retain: true });
  mqtt.last.deliver('teslamate/cars/1/locked', 'false', { retain: true });
  await clock.advance(3 * SECOND);
  const [locked] = statesOf(gladys, F('locked'));
  assert.ok(Date.parse(locked.created_at) <= clock.now(), 'never in the future');
});

test('created after the values arrived: they are sent dated, never as new', async () => {
  const { gladys, mqtt, clock } = await setup();
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  mqtt.last.deliver('teslamate/cars/1/battery_level', '70');
  await clock.advance(SECOND);
  const receivedAt = clock.now();
  await clock.advance(MINUTE);
  const [device] = gladys.fake.discoveredDevices;
  await gladys.fake.deviceCreated(device);
  await clock.advance(1.1 * SECOND);
  const [battery] = statesOf(gladys, F('battery_level'));
  assert.equal(battery.state, 70);
  assert.ok(Date.parse(battery.created_at) <= receivedAt, 'dated when read');
  const [locked] = statesOf(gladys, F('locked'));
  assert.equal(locked.created_at, new Date(Date.parse(SINCE)).toISOString(), 'retained: at since');
  assert.equal(statesOf(gladys, F('position')).length, 0);
});

test('a reconnection to Gladys sends no value again; a broker reconnection only what changed', async () => {
  const device = createdCar({ features: ALL });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  const count = gladys.fake.states.length;
  assert.ok(count > 10);
  await gladys.disconnect();
  await gladys.connect();
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.states.length, count, 'Gladys reconnected: nothing again');
  assert.equal(mqtt.clients.length, 1, 'the MQTT client is kept');
  // The broker restarts: the retained burst again, one value changed meanwhile.
  mqtt.last.close();
  await settle();
  assert.match(statusText(gladys), /lost/);
  mqtt.last.open();
  deliverCar(mqtt.last, carTopics({ battery_level: '60' }));
  await clock.advance(3 * SECOND);
  const added = gladys.fake.states.slice(count);
  assert.deepEqual(
    added.map((s) => [s.device_feature_external_id, s.state]),
    [[F('battery_level'), 60]],
  );
  assert.ok(added[0].created_at, 'dated');
});

test('position: off by default never read; on, rounded to about 100 m; off again, erased', async () => {
  const device = createdCar({ features: [...ALL] });
  const { gladys, mqtt, clock, logger } = await setup({ devices: [device] });
  mqtt.last.deliver('teslamate/cars/1/location', '{"latitude": 48.858372, "longitude": 2.294481}');
  await clock.advance(2 * SECOND);
  assert.equal(statesOf(gladys, F('position')).length, 0);
  await gladys.fake.configUpdated({ ...CONFIG, publish_position: true });
  assert.equal(mqtt.clients.length, 1, 'an option: no reconnection');
  mqtt.last.deliver('teslamate/cars/1/location', '{"latitude": 48.858372, "longitude": 2.294481}');
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('position')), '48.858, 2.294');
  for (const bad of [
    '{"latitude": 91, "longitude": 2}',
    '{"latitude": "48"}',
    'nil',
    '[1,2]',
    '{"latitude":0,"longitude":0}',
  ]) {
    mqtt.last.deliver('teslamate/cars/1/location', bad);
  }
  mqtt.last.deliver('teslamate/cars/1/latitude', '48.858372');
  mqtt.last.deliver(
    'teslamate/cars/1/active_route',
    '{"destination":"Work","location":{"latitude":1,"longitude":2}}',
  );
  await clock.advance(2 * SECOND);
  assert.equal(statesOf(gladys, F('position')).length, 1);
  await gladys.fake.configUpdated({ ...CONFIG, publish_position: false });
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('position')), '', 'erased');
  mqtt.last.deliver('teslamate/cars/1/location', '{"latitude": 40.1, "longitude": 3.2}');
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('position')), '');
  assert.ok(!logger.lines.join('\n').includes('48.85'), 'never logged');
});

test('geofence turned off: erased and no longer read', async () => {
  const device = createdCar({
    features: ['geofence'],
    values: { geofence: { value: 'Home', at: SINCE } },
  });
  const { gladys, mqtt, clock } = await setup({
    devices: [device],
    config: { ...CONFIG, publish_geofence: false },
  });
  await clock.advance(2 * SECOND);
  // Off at start (turned off while the integration was not running): the
  // value Gladys shows is erased, and the topic is not read.
  assert.deepEqual(
    statesOf(gladys, F('geofence')).map((s) => s.text),
    [''],
  );
  mqtt.last.deliver('teslamate/cars/1/geofence', 'Work');
  await clock.advance(2 * SECOND);
  assert.equal(statesOf(gladys, F('geofence')).length, 1);
  await gladys.fake.configUpdated({ ...CONFIG, publish_geofence: true });
  mqtt.last.deliver('teslamate/cars/1/geofence', 'Work');
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('geofence')), 'Work');
  await gladys.fake.configUpdated({ ...CONFIG, publish_geofence: false });
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('geofence')), '');
});

test('namespace: its own topics and ids; another namespace and odd topics ignored', async () => {
  const { gladys, mqtt, clock } = await setup({ config: { ...CONFIG, namespace: 'account_0' } });
  assert.deepEqual(mqtt.last.subscriptions, ['teslamate/account_0/cars/+/+']);
  deliverCar(mqtt.last, carTopics(), { ns: 'account_0', car: 2 });
  deliverCar(mqtt.last, carTopics(), { car: 3 });
  for (const topic of [
    'teslamate/account_0/cars/0/battery_level',
    'teslamate/account_0/cars/01/battery_level',
    'teslamate/account_0/cars/1234567/battery_level',
    'teslamate/account_0/cars/abc/battery_level',
    'teslamate/account_0/cars/4/battery_level/x',
    'teslamate/account_0/cars/4/__proto__',
  ]) {
    mqtt.last.deliver(topic, '50', { retain: true });
  }
  await clock.advance(3 * SECOND);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE(2, 'account_0')],
  );
});

test('the same VIN under two car ids is flagged, the VIN never shown', async () => {
  const { gladys, mqtt, clock, logger } = await setup();
  deliverCar(mqtt.last, carTopics(), { car: 1 });
  deliverCar(mqtt.last, carTopics({ name: 'Old' }), { car: 2 });
  deliverCar(mqtt.last, carTopics({ name: 'Other', vin: '5YJ3E7EB0KF999999' }), { car: 3 });
  await clock.advance(3 * SECOND);
  const param = (d, name) => d.params.find((p) => p.name === name)?.value;
  const [one, two, three] = gladys.fake.discoveredDevices;
  assert.equal(param(one, 'TESLAMATE_SAME_CAR_AS'), '2');
  assert.equal(param(two, 'TESLAMATE_SAME_CAR_AS'), '1');
  assert.equal(param(three, 'TESLAMATE_SAME_CAR_AS'), undefined);
  const all = JSON.stringify([gladys.fake.discoveredDevices, gladys.fake.requests, logger.lines]);
  assert.ok(!all.includes(VIN) && !all.includes('KF999999'));
});

test('at most 20 cars, said in the status', async () => {
  const { gladys, mqtt, clock } = await setup();
  for (let car = 1; car <= 25; car += 1) {
    mqtt.last.deliver(`teslamate/cars/${car}/battery_level`, '50', { retain: true });
  }
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.discoveredDevices.length, 20);
  assert.match(statusText(gladys), /5 other car id/);
});

test('a payload too large or not UTF-8 is ignored, the others still read', async () => {
  const device = createdCar({ features: ['battery_level', 'state'] });
  const { gladys, mqtt, clock, logger } = await setup({ devices: [device] });
  mqtt.last.deliver('teslamate/cars/1/state', 'x'.repeat(5000));
  assert.ok(
    logger.lines.some((l) => l.includes('A value of state was ignored (size, encoding)')),
    'refused before it is decoded',
  );
  mqtt.last.deliver('teslamate/cars/1/state', Buffer.from([0xff, 0xfe, 0x61]));
  mqtt.last.deliver('teslamate/cars/1/battery_level', '50');
  await clock.advance(1.1 * SECOND);
  assert.equal(statesOf(gladys, F('state')).length, 0);
  assert.equal(gladys.fake.lastState(F('battery_level')), 50);
});

test('the states stay within 250 per minute and measurements 10 s apart', async () => {
  const keys = ['battery_level', 'locked'];
  const devices = Array.from({ length: 20 }, (_, i) => createdCar({ car: i + 1, features: keys }));
  const { gladys, mqtt, clock } = await setup({ devices });
  // 20 cars, a lock toggling every 100 ms each: far over the budget.
  for (let t = 0; t < 600; t += 1) {
    for (let car = 1; car <= 20; car += 1) {
      mqtt.last.deliver(`teslamate/cars/${car}/locked`, t % 2 ? 'true' : 'false');
      mqtt.last.deliver(`teslamate/cars/${car}/battery_level`, String(t % 100));
    }
    await clock.advance(100);
  }
  const sends = gladys.fake.requests.filter(
    (r) => r.path === '/state' || r.path?.includes('state'),
  );
  assert.ok(sends.length > 0);
  const total = gladys.fake.states.length;
  assert.ok(total <= 250 + 5, `${total} states in 60 s`);
  const battery = statesOf(gladys, F('battery_level'));
  assert.ok(battery.length <= 7, `${battery.length} battery states in 60 s`);
});

test('Transport badge: unreachable when the broker is lost, degraded when TeslaMate is unhealthy', async () => {
  const device = createdCar({ features: ['battery_level'] });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  mqtt.last.deliver('teslamate/cars/1/healthy', 'false');
  await settle();
  const degraded = gladys.fake.transports.at(-1);
  assert.equal(degraded.degraded, true);
  assert.match(statusText(gladys), /healthy: false/);
  mqtt.last.close();
  await settle();
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
});

test('no TeslaMate message: the status says so after 30 s', async () => {
  const { gladys, clock } = await setup();
  assert.match(statusText(gladys), /waiting for TeslaMate/);
  await clock.advance(31 * SECOND);
  assert.match(statusText(gladys), /nothing from TeslaMate on teslamate\/cars\//);
  assert.equal(gladys.fake.connectionStatus.connected, false);
});

test('refused credentials: persisted stop, no retry before 15 min, never the password', async () => {
  const store = memoryStore();
  const { gladys, mqtt, clock, logger } = await setup({ store, open: false });
  mqtt.last.refuse(5);
  await settle();
  assert.equal(mqtt.clients.length, 1);
  assert.ok(mqtt.last.ended);
  assert.match(statusText(gladys), /refused.*15 min/);
  assert.equal(store.data.auth.failures, 1);
  await clock.advance(14 * MINUTE);
  assert.equal(mqtt.clients.length, 1, 'no retry before the end of the stop');
  await clock.advance(2 * MINUTE);
  assert.equal(mqtt.clients.length, 2);
  mqtt.last.refuse(5);
  await settle();
  assert.match(statusText(gladys), /1 h/);
  const everything = JSON.stringify([
    store.data,
    gladys.fake.requests,
    gladys.fake.connectionStatuses,
    logger.lines,
  ]);
  assert.ok(!everything.includes(PASSWORD));
});

test('the stop survives a restart; other credentials lift it', async () => {
  const store = memoryStore();
  const first = await setup({ store, open: false });
  first.mqtt.last.refuse(4);
  await settle();
  first.app.stop();
  const clock = first.clock;
  const second = await setup({ store, open: false, clock });
  assert.equal(second.mqtt.clients.length, 0, 'still stopped after the restart');
  assert.match(statusText(second.gladys), /Stopped/);
  await second.gladys.fake.configUpdated({ ...CONFIG, password: 'another' });
  assert.equal(second.mqtt.clients.length, 1, 'new credentials: tried at once');
  second.mqtt.last.open();
  await settle();
  assert.equal(store.data.auth.failures, 0);
});

test('a CONNECT swallowed twice with credentials counts as a refusal', async () => {
  const { gladys, mqtt, app } = await setup({ open: false });
  const hooks = mqtt.last.options;
  for (let i = 0; i < 2; i += 1) {
    hooks.onAttempt();
    hooks.onOpen();
    mqtt.last.emit('close');
    await settle();
  }
  assert.match(statusText(gladys), /refused/);
  assert.equal(app.memory.auth.failures, 1);
});

test('MQTT 5 refused: 3.1.1, said in the status', async () => {
  const { gladys, mqtt, clock } = await setup({ open: false });
  mqtt.last.refuse(1);
  await settle();
  assert.equal(mqtt.clients.length, 2);
  assert.equal(mqtt.last.options.protocolVersion, 4);
  mqtt.last.open();
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  assert.match(statusText(gladys), /MQTT 3\.1\.1/);
});

test('getConfig failing in connected: retried, spaced, without end, then the start', async () => {
  // Each call: true = answered. The SDK's own resynchronization of connect()
  // comes first (it must succeed, else the SDK closes); then the app's reads.
  const plan = [true, false, false, false];
  const { gladys, mqtt, clock } = await setup({
    open: false,
    getConfig: (original) =>
      plan.length === 0 || plan.shift() ? original() : Promise.reject(new Error('timeout')),
  });
  assert.equal(mqtt.clients.length, 0);
  assert.match(statusText(gladys), /could not be read.*5 s/);
  await clock.advance(5 * SECOND);
  assert.match(statusText(gladys), /15 s/);
  await clock.advance(15 * SECOND);
  assert.match(statusText(gladys), /60 s/);
  assert.equal(mqtt.clients.length, 0);
  await clock.advance(MINUTE);
  assert.equal(mqtt.clients.length, 1, 'started once the configuration was read');
  // Gladys reconnects and the read fails once more: the client is kept, the read retried.
  plan.push(true, false);
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.match(statusText(gladys), /could not be read/);
  await clock.advance(5 * SECOND);
  assert.equal(mqtt.clients.length, 1);
  assert.match(statusText(gladys), /Connecting|waiting|nothing/);
});

test('configuration problems are said, nothing is connected', async () => {
  for (const [config, pattern] of [
    [{ broker_url: '' }, /Type the address/],
    [{ broker_url: 'http://x' }, /not valid/],
    [{ broker_url: 'mqtt://u:p@host' }, /own fields/],
    [{ broker_url: '0.0.0.0' }, /not valid/],
    [{ broker_url: 'host', password: 'p' }, /without a user name/],
    [{ broker_url: 'host', username: 'a\r\nb' }, /control character/],
    [{ broker_url: 'host', namespace: 'a/b' }, /namespace/],
    [{ broker_url: 'host', namespace: '#' }, /namespace/],
    [{ broker_url: 'host', namespace: 'default' }, /namespace/],
  ]) {
    const { gladys, mqtt } = await setup({ config, open: false });
    assert.equal(mqtt.clients.length, 0, JSON.stringify(config));
    assert.match(statusText(gladys), pattern);
  }
});

test('Test the connection: names the cars, cooldown, says when nothing comes', async () => {
  const { gladys, mqtt, clock } = await setup();
  const pending = gladys.fake.action('test_connection', {});
  await until(() => mqtt.clients.length === 2, 'the probe');
  const probe = mqtt.last;
  const again = await within(gladys.fake.action('test_connection', {}));
  assert.match(again.data.message.en, /Wait/);
  assert.equal(mqtt.clients.length, 2, 'a click in the cooldown reaches nothing');
  probe.open();
  deliverCar(probe, carTopics(), { car: 1 });
  deliverCar(probe, carTopics({ name: 'Red' }), { car: 2 });
  await clock.advance(11 * SECOND);
  const answer = await within(pending);
  assert.match(answer.data.message.en, /2 car\(s\): Blue Thunder, Red/);
  assert.ok(probe.ended);
  await clock.advance(11 * SECOND);
  const second = gladys.fake.action('test_connection', {});
  await until(() => mqtt.clients.length === 3, 'the second probe');
  mqtt.last.open();
  await clock.advance(12 * SECOND);
  assert.match((await within(second)).data.message.en, /no TeslaMate car/);
});

test('Test the connection after a refusal: the stop is lifted when the broker accepts', async () => {
  const { gladys, mqtt, app, clock } = await setup({ open: false });
  mqtt.last.refuse(5);
  await settle();
  assert.equal(app.memory.auth.failures, 1);
  const pending = gladys.fake.action('test_connection', {});
  await until(() => mqtt.clients.length === 2, 'the probe');
  mqtt.last.open();
  await clock.advance(12 * SECOND);
  await within(pending);
  assert.equal(app.memory.auth.failures, 0);
  assert.equal(mqtt.clients.length, 3, 'reconnected at once');
});

test('a deleted device: nothing more sent; stop() leaves no timer', async () => {
  const device = createdCar({ features: ['battery_level'] });
  const { gladys, mqtt, clock, app } = await setup({ devices: [device] });
  await gladys.fake.deviceDeleted(device);
  mqtt.last.deliver('teslamate/cars/1/battery_level', '50');
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.states.length, 0);
  app.stop();
  assert.equal(clock.pending, 0, 'no timer after stop()');
  assert.ok(mqtt.last.ended);
});

test('a scan publishes the list now; names follow the language option', async () => {
  const { gladys, mqtt, clock } = await setup({ config: { ...CONFIG, language: 'en' } });
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  const before = gladys.fake.requests.length;
  await gladys.fake.scanRequest();
  assert.ok(gladys.fake.requests.length > before);
  const names = gladys.fake.discoveredDevices[0].features.map((f) => f.name);
  assert.ok(names.includes('Battery level'));
});

test('a created feature the build lacks is kept (no "Update")', async () => {
  const device = createdCar({ features: ['battery_level', 'tyre_front_left'] });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  mqtt.last.deliver('teslamate/cars/1/battery_level', '50', { retain: true });
  await clock.advance(3 * SECOND);
  const ids = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(ids.includes(F('tyre_front_left')));
});

test('a reconnection after a configuration change sends nothing already sent', async () => {
  const device = createdCar({
    features: ALL,
    values: { battery_level: { value: 50, at: '2026-02-01T00:00:00.000Z' } },
  });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverCar(mqtt.last, carTopics(), { retain: false });
  await clock.advance(3 * SECOND);
  const count = gladys.fake.states.length;
  assert.ok(count > 10);
  await gladys.fake.configUpdated({ ...CONFIG, verify_certificate: false });
  assert.equal(mqtt.clients.length, 2, 'reconnected');
  mqtt.last.open();
  const reconnectedAt = clock.now();
  deliverCar(mqtt.last, carTopics({ battery_level: '61' }));
  await clock.advance(3 * SECOND);
  const added = gladys.fake.states.slice(count);
  assert.deepEqual(
    added.map((s) => [s.device_feature_external_id, s.state]),
    [[F('battery_level'), 61]],
    'only the value that changed',
  );
  // Dated just after the value sent before the reconnection, not after the
  // older one the device list of Gladys still holds.
  assert.ok(Date.parse(added[0].created_at) >= reconnectedAt - 4 * SECOND);
});

test('r1 I1: a configuration saved during the retry of getConfig: the values still go out', async () => {
  const plan = [true, false];
  let calls = 0;
  const device = createdCar({ features: ['battery_level'] });
  const { gladys, mqtt, clock } = await setup({
    devices: [device],
    open: false,
    getConfig: (original) => {
      calls += 1;
      return plan.length === 0 || plan.shift() ? original() : Promise.reject(new Error('timeout'));
    },
  });
  assert.match(statusText(gladys), /could not be read/);
  await gladys.fake.configUpdated(CONFIG);
  assert.equal(mqtt.clients.length, 1);
  mqtt.last.open();
  mqtt.last.deliver('teslamate/cars/1/battery_level', '64');
  await clock.advance(1.5 * SECOND);
  assert.equal(gladys.fake.lastState(F('battery_level')), 64, 'the created device is known');
  // The retry of the read still runs, and keeps the client.
  await clock.advance(6 * SECOND);
  assert.equal(calls, 3, 'the read was tried again after 5 s');
  assert.equal(mqtt.clients.length, 1);
});

test('r1 I2: an option off at start erases the value Gladys shows, once', async () => {
  const device = createdCar({
    features: ['position', 'geofence'],
    values: {
      position: { value: '48.858, 2.294', at: SINCE },
      geofence: { value: 'Home', at: SINCE },
    },
  });
  const { gladys, clock } = await setup({
    devices: [device],
    config: { ...CONFIG, publish_geofence: false },
    open: false,
  });
  await clock.advance(1.5 * SECOND);
  assert.equal(gladys.fake.lastState(F('position')), '', 'even without the broker');
  assert.equal(gladys.fake.lastState(F('geofence')), '');
  await gladys.disconnect();
  await gladys.connect();
  await clock.advance(1.5 * SECOND);
  assert.equal(statesOf(gladys, F('position')).length, 1, 'idempotent');
});

test('r1 I3: an option turned on reads the retained values again, dated', async () => {
  const device = createdCar({ features: ['position', 'battery_level'] });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  assert.equal(statesOf(gladys, F('position')).length, 0);
  await gladys.fake.configUpdated({ ...CONFIG, publish_position: true });
  assert.deepEqual(mqtt.last.subscriptions, ['teslamate/cars/+/+', 'teslamate/cars/+/+']);
  // The broker sends its retained values again for the new subscription.
  deliverCar(mqtt.last);
  await clock.advance(3 * SECOND);
  const [position] = statesOf(gladys, F('position'));
  assert.equal(position.text, '48.858, 2.294');
  assert.equal(position.created_at, new Date(Date.parse(SINCE)).toISOString(), 'dated');
});

test('r1 I4: /data slow at start: no connection before it answers, its stop kept', async () => {
  const until = Date.parse('2026-03-01T18:00:00Z');
  const store = memoryStore({ auth: { failures: 3, until } });
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const load = store.load.bind(store);
  store.load = async () => {
    await slow;
    return load();
  };
  const clock = testClock({ start: Date.parse('2026-03-01T12:00:00Z') });
  // The start waits for /data (5 s at most): the setup runs while the clock moves.
  const starting = setup({ store, open: false, clock });
  await settle();
  await clock.advance(6 * SECOND);
  const { gladys, mqtt } = await within(starting);
  assert.equal(mqtt.clients.length, 0, 'not read: no connection');
  assert.match(statusText(gladys), /could not be read.*10 s/);
  release();
  await settle();
  await clock.advance(10 * SECOND);
  assert.equal(mqtt.clients.length, 0, 'the stop of /data holds');
  assert.match(statusText(gladys), /Stopped/);
  assert.equal(store.data.auth.failures, 3, 'never overwritten');
  assert.equal(store.saves, 0);
});

test('r1 I4: /data unreadable (EIO): tried again, then connected without writing over it', async () => {
  const store = memoryStore({ auth: { failures: 3, until: Date.parse('2026-03-02T00:00:00Z') } });
  let reads = 0;
  store.load = async () => {
    reads += 1;
    const err = new Error('EIO: i/o error');
    err.code = 'EIO';
    throw err;
  };
  const { gladys, mqtt, clock } = await setup({ store, open: false });
  assert.equal(mqtt.clients.length, 0);
  assert.match(statusText(gladys), /\/data could not be read/);
  await clock.advance(70 * SECOND);
  assert.equal(reads, 6, 'one read every 10 s, six at most');
  assert.equal(mqtt.clients.length, 1, 'then connected');
  mqtt.last.refuse(5);
  await settle();
  assert.equal(store.saves, 0, 'nothing written over the unread state');
  assert.match(statusText(gladys), /refused/);
});

test('r1 I5: a swallowed CONNECT, then accepted, then swallowed: no refusal', async () => {
  const { gladys, mqtt, app } = await setup({ open: false });
  const client = mqtt.last;
  const hooks = client.options;
  hooks.onAttempt();
  hooks.onOpen();
  client.emit('close');
  await settle();
  hooks.onAttempt();
  client.open();
  await settle();
  client.connected = false;
  client.emit('close');
  hooks.onAttempt();
  hooks.onOpen();
  client.emit('close');
  await settle();
  assert.equal(app.memory.auth.failures, 0);
  assert.doesNotMatch(statusText(gladys), /refused/);
});

test('r1 I5: retained values before `since` in the burst are dated at since', async () => {
  const device = createdCar({ features: ['battery_level'] });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  mqtt.last.deliver('teslamate/cars/1/battery_level', '70', { retain: true });
  await clock.advance(500);
  mqtt.last.deliver('teslamate/cars/1/since', SINCE, { retain: true });
  await clock.advance(3 * SECOND);
  const [battery] = statesOf(gladys, F('battery_level'));
  assert.equal(battery?.created_at, new Date(Date.parse(SINCE)).toISOString());
});

test('r1 m2: after 3 failed attempts in a row, one try a minute', async () => {
  const { gladys, mqtt } = await setup({ open: false });
  const client = mqtt.last;
  client.options.reconnectPeriod = 10_000;
  for (let i = 0; i < 3; i += 1) {
    client.emit(
      'error',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    client.emit('close');
    await settle();
  }
  assert.equal(client.options.reconnectPeriod, 60_000);
  client.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  await settle();
  assert.match(statusText(gladys), /next try in 60 s/);
  client.open();
  await settle();
  assert.equal(client.options.reconnectPeriod, 10_000, 'back to 10 s once connected');
});

test('r2: an absurd odometer is left behind by deleting the feature or the device', async () => {
  const device = createdCar({ features: ['odometer', 'battery_level'] });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  mqtt.last.deliver('teslamate/cars/1/odometer', '4999999');
  await clock.advance(1.5 * SECOND);
  mqtt.last.deliver('teslamate/cars/1/odometer', '1700');
  await clock.advance(1.5 * SECOND);
  assert.equal(statesOf(gladys, F('odometer')).length, 1, 'blocked by the absurd value');
  // The user removes the odometer feature (device updated), then adds it back.
  const without = {
    ...device,
    features: device.features.filter((f) => f.external_id !== F('odometer')),
  };
  await gladys.fake.deviceUpdated(without);
  await gladys.fake.deviceUpdated(createdCar({ features: ['odometer', 'battery_level'] }));
  mqtt.last.deliver('teslamate/cars/1/odometer', '1701');
  await clock.advance(1.5 * SECOND);
  assert.equal(gladys.fake.lastState(F('odometer')), 1701, 'starts over');
  // Deleting the whole device also starts over.
  mqtt.last.deliver('teslamate/cars/1/odometer', '4999999');
  await clock.advance(1.5 * SECOND);
  await gladys.fake.deviceDeleted(createdCar({ features: ['odometer', 'battery_level'] }));
  await gladys.fake.deviceCreated(createdCar({ features: ['odometer', 'battery_level'] }));
  mqtt.last.deliver('teslamate/cars/1/odometer', '1702');
  await clock.advance(1.5 * SECOND);
  assert.equal(gladys.fake.lastState(F('odometer')), 1702);
});
