// The app against the SDK's fake Gladys, a fake broker and a virtual clock.

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TeslaMateApp } from '../../src/app.js';
import { buildDevice } from '../../src/car.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { testClock, settle } from './clock.js';
import { fakeConnector } from './fakeMqtt.js';

export { settle };

export const SELECTOR = 'test-integration';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const PASSWORD = 'S3cr3t-Pa55word!';
export const VIN = '5YJ3E7EB0KF123456';
export const CONFIG = { broker_url: '192.168.1.20', username: 'gladys', password: PASSWORD };
export const DEVICE = (car = 1, ns = 'default') => `ext:${SELECTOR}:car:${ns}-${car}`;
export const F = (key, car = 1, ns = 'default') => `${DEVICE(car, ns)}:${key}`;
export const SINCE = '2026-01-01T00:00:00Z';

/** What TeslaMate keeps on the broker for a car (retained), as in its docs. */
export function carTopics({ name = 'Blue Thunder', since = SINCE, ...over } = {}) {
  return {
    display_name: name,
    state: 'asleep',
    since,
    healthy: 'true',
    model: '3',
    vin: VIN,
    battery_level: '88',
    usable_battery_level: '85',
    rated_battery_range_km: '401.63',
    est_battery_range_km: '372.5',
    plugged_in: 'true',
    charging_state: 'Complete',
    charge_limit_soc: '90',
    charge_energy_added: '5.06',
    charger_power: '0',
    inside_temp: '20.8',
    outside_temp: '18.4',
    is_climate_on: 'false',
    odometer: '1653',
    locked: 'true',
    sentry_mode: 'false',
    doors_open: 'false',
    trunk_open: 'false',
    frunk_open: 'false',
    windows_open: 'false',
    tpms_pressure_fl: '2.9',
    tpms_pressure_fr: '2.8',
    tpms_pressure_rl: '2.9',
    tpms_pressure_rr: '2.8',
    geofence: 'Home',
    location: '{"latitude": 48.858372, "longitude": 2.294481}',
    active_route: '{"destination":"Work","location":{"latitude":48.1,"longitude":2.1}}',
    speed: '12',
    heading: '340',
    ...over,
  };
}

/** Delivers the topics of a car (retained by default). */
export function deliverCar(client, topics = carTopics(), { car = 1, retain = true, ns } = {}) {
  const prefix = ns ? `teslamate/${ns}/cars/${car}/` : `teslamate/cars/${car}/`;
  for (const [suffix, payload] of Object.entries(topics)) {
    client.deliver(`${prefix}${suffix}`, payload, { retain });
  }
}

export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(
        `${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`,
      );
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child() {
      return this;
    },
  };
}

/**
 * A created device of a car, as Gladys keeps it: `values` gives
 * last_value / last_value_string and last_value_changed per feature key.
 */
export function createdCar({ car = 1, ns, features, values = {}, language = 'fr' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const keys = new Set(features ?? Object.keys(values));
  const device = buildDevice(
    gladys,
    { namespace: ns, carId: String(car), features: keys },
    language,
  );
  for (const feature of device.features) {
    const key = feature.external_id.split(':').at(-1);
    const entry = values[key];
    if (entry) {
      if (typeof entry.value === 'string') {
        feature.last_value_string = entry.value;
      } else {
        feature.last_value = entry.value;
      }
      feature.last_value_changed = entry.at;
    }
  }
  return device;
}

export async function setup({
  config = CONFIG,
  devices = [],
  store = memoryStore(),
  clock = testClock({ start: Date.parse('2026-03-01T12:00:00Z') }),
  open = true,
  getConfig,
} = {}) {
  const logger = memoryLogger();
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices, logger });
  if (getConfig) {
    const original = gladys.getConfig.bind(gladys);
    gladys.getConfig = () => getConfig(original);
  }
  const mqtt = fakeConnector();
  const app = new TeslaMateApp({
    gladys,
    logger,
    connect: mqtt.connect,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await settle();
  if (open && mqtt.last) {
    mqtt.last.open();
    await settle();
  }
  return { gladys, app, mqtt, clock, store, logger };
}

/** Lets the event loop turn until `condition()` holds (bounded: throws after 200 turns). */
export async function until(condition, what = 'condition') {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) {
      return;
    }
    await settle(1);
  }
  throw new Error(`never: ${what}`);
}

/** A promise bounded in real time: a test fails, it never hangs. */
export function within(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The states Gladys received for a feature. */
export const statesOf = (gladys, id) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === id);

/** The last status message (English). */
export const statusText = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';
