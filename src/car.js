// -----------------------------------------------------------------------------
// A car of TeslaMate, as Gladys sees it: which documented TeslaMate topic
// (docs.teslamate.org, "MQTT Integration") feeds which feature, how its
// payload is read, and the device built from the topics seen.
//
// Only the documented topics are read, and only their payload: nothing of
// TeslaMate's code is used. Every payload is checked strictly: a number is
// digits (never '' read as 0), a boolean is "true" or "false", a value out of
// its range or of an unexpected shape is UNKNOWN (nothing published, the last
// value stays). An empty payload means "the car reports no value" (TeslaMate
// docs): unknown too, never 0.
//
// Never read: the VIN (only compared in memory to spot one car under two
// ids, src/app.js), the navigation (active_route: destination and its
// position), speed, heading, elevation, shift state, the deprecated
// latitude / longitude topics. The position (`location`) is read only when
// the configuration allows it, rounded to POSITION_DECIMALS.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEFAULT_NAMESPACE_ID, DEVICE_TYPE, LIMITS, POSITION_DECIMALS } from './constants.js';
import { FEATURE_NAMES } from './i18n.js';

/** Gladys' charging-station charging states (OCPP values, server/utils/constants.js). */
export const CHARGING = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
};

/** TeslaMate `charging_state` -> Gladys charging state (the mapping of gladys-tesla). */
const CHARGING_STATES = {
  Charging: CHARGING.CHARGING,
  Starting: CHARGING.EV_CONNECTED,
  Stopped: CHARGING.PAUSED_BY_VEHICLE,
  NoPower: CHARGING.PAUSED_BY_CHARGER,
  Complete: CHARGING.IDLE,
  Disconnected: CHARGING.IDLE,
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A strict decimal number: optional sign, digits, optional decimals. Never '' nor ' 1'. */
const NUMBER = /^-?\d{1,9}(\.\d{1,9})?$/;

export function strictNumber(text) {
  return NUMBER.test(text) ? Number(text) : undefined;
}

const number =
  ({ min, max, decimals = 2 }) =>
  (text) => {
    const value = strictNumber(text);
    if (value === undefined || value < min || value > max) {
      return undefined;
    }
    const factor = 10 ** decimals;
    return { state: Math.round(value * factor) / factor };
  };

const integer =
  ({ min, max }) =>
  (text) => {
    if (!/^-?\d{1,9}$/.test(text)) {
      return undefined;
    }
    const value = Number(text);
    return value < min || value > max ? undefined : { state: value };
  };

const boolean = (text) =>
  text === 'true' ? { state: 1 } : text === 'false' ? { state: 0 } : undefined;

/** A short text, single line, trimmed; '' allowed when `empty` (geofence: "no geofence"). */
const text =
  ({ empty = false, pattern } = {}) =>
  (raw) => {
    const value = raw.trim();
    if (value === '') {
      return empty ? { text: '' } : undefined;
    }
    if (value.length > LIMITS.text || CONTROL.test(value)) {
      return undefined;
    }
    if (pattern && !pattern.test(value)) {
      return undefined;
    }
    return { text: value };
  };

const charging = (raw) =>
  Object.hasOwn(CHARGING_STATES, raw) ? { state: CHARGING_STATES[raw] } : undefined;

/** `{ "latitude": 48.85, "longitude": 2.35 }` -> "48.857, 2.352" (rounded). */
export function roundedPosition(raw) {
  if (raw.length > 512 || !raw.trimStart().startsWith('{')) {
    return undefined;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const lat = value?.latitude;
  const lon = value?.longitude;
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  ) {
    return undefined;
  }
  const round = (v) => {
    const r = Number(v.toFixed(POSITION_DECIMALS));
    return (Object.is(r, -0) ? 0 : r).toFixed(POSITION_DECIMALS);
  };
  return { text: `${round(lat)}, ${round(lon)}` };
}

const feature = (category, type, { unit, min = 0, max = 1, kind = 'binary', option } = {}) => ({
  category,
  type,
  unit,
  min,
  max,
  kind,
  option,
});

/**
 * Feature key (frozen, part of the external id) -> the TeslaMate topic
 * suffix it reads, its Gladys category/type/unit and its parser. `kind`:
 * 'measurement' (throttled), 'binary', 'text', 'enum', 'counter' (never
 * decreasing). `option`: the configuration switch it needs.
 */
export const FEATURES = {
  battery_level: {
    topic: 'battery_level',
    parse: integer({ min: 0, max: 100 }),
    ...feature(C.ELECTRICAL_VEHICLE_BATTERY, T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL, {
      unit: U.PERCENT,
      max: 100,
      kind: 'measurement',
    }),
  },
  usable_battery_level: {
    topic: 'usable_battery_level',
    parse: integer({ min: 0, max: 100 }),
    ...feature(C.ELECTRICAL_VEHICLE_BATTERY, T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL, {
      unit: U.PERCENT,
      max: 100,
      kind: 'measurement',
    }),
  },
  rated_range: {
    topic: 'rated_battery_range_km',
    parse: number({ min: 0, max: 2000, decimals: 1 }),
    ...feature(C.ELECTRICAL_VEHICLE_BATTERY, T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_RANGE_ESTIMATE, {
      unit: U.KM,
      max: 2000,
      kind: 'measurement',
    }),
  },
  estimated_range: {
    topic: 'est_battery_range_km',
    parse: number({ min: 0, max: 2000, decimals: 1 }),
    ...feature(C.ELECTRICAL_VEHICLE_BATTERY, T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_RANGE_ESTIMATE, {
      unit: U.KM,
      max: 2000,
      kind: 'measurement',
    }),
  },
  charging_state: {
    topic: 'charging_state',
    parse: charging,
    ...feature(C.CHARGING_STATION, T.CHARGING_STATION.CHARGING_STATE, { max: 5, kind: 'enum' }),
  },
  plugged_in: {
    topic: 'plugged_in',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_CHARGE, T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED),
  },
  charger_power: {
    topic: 'charger_power',
    parse: number({ min: 0, max: 400, decimals: 1 }),
    ...feature(C.ELECTRICAL_VEHICLE_CHARGE, T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_POWER, {
      unit: U.KILOWATT,
      max: 400,
      kind: 'measurement',
    }),
  },
  charger_current: {
    topic: 'charger_actual_current',
    parse: number({ min: 0, max: 1000, decimals: 1 }),
    ...feature(C.ELECTRICAL_VEHICLE_CHARGE, T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_CURRENT, {
      unit: U.AMPERE,
      max: 1000,
      kind: 'measurement',
    }),
  },
  charger_voltage: {
    topic: 'charger_voltage',
    parse: number({ min: 0, max: 1000, decimals: 0 }),
    ...feature(C.ELECTRICAL_VEHICLE_CHARGE, T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_VOLTAGE, {
      unit: U.VOLT,
      max: 1000,
      kind: 'measurement',
    }),
  },
  charge_energy_added: {
    topic: 'charge_energy_added',
    parse: number({ min: 0, max: 500, decimals: 2 }),
    ...feature(C.ELECTRICAL_VEHICLE_CHARGE, T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED, {
      unit: U.KILOWATT_HOUR,
      max: 500,
      kind: 'measurement',
    }),
  },
  charge_limit: {
    topic: 'charge_limit_soc',
    parse: integer({ min: 0, max: 100 }),
    ...feature(C.ELECTRICAL_VEHICLE_CHARGE, T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CHARGE_LIMIT, {
      unit: U.PERCENT,
      max: 100,
      kind: 'measurement',
    }),
  },
  inside_temperature: {
    topic: 'inside_temp',
    parse: number({ min: -60, max: 100, decimals: 1 }),
    ...feature(C.ELECTRICAL_VEHICLE_CLIMATE, T.ELECTRICAL_VEHICLE_CLIMATE.INDOOR_TEMPERATURE, {
      unit: U.CELSIUS,
      min: -60,
      max: 100,
      kind: 'measurement',
    }),
  },
  outside_temperature: {
    topic: 'outside_temp',
    parse: number({ min: -60, max: 70, decimals: 1 }),
    ...feature(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
      unit: U.CELSIUS,
      min: -60,
      max: 70,
      kind: 'measurement',
    }),
  },
  climate_on: {
    topic: 'is_climate_on',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_CLIMATE, T.ELECTRICAL_VEHICLE_CLIMATE.CLIMATE_ON),
  },
  odometer: {
    topic: 'odometer',
    parse: number({ min: 0, max: 5_000_000, decimals: 1 }),
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.ODOMETER, {
      unit: U.KM,
      max: 5_000_000,
      kind: 'counter',
    }),
  },
  locked: {
    topic: 'locked',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_COMMAND, T.ELECTRICAL_VEHICLE_COMMAND.LOCK),
  },
  sentry_mode: {
    topic: 'sentry_mode',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_COMMAND, T.ELECTRICAL_VEHICLE_COMMAND.ALARM),
  },
  doors_open: {
    topic: 'doors_open',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED),
  },
  trunk_open: {
    topic: 'trunk_open',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED),
  },
  frunk_open: {
    topic: 'frunk_open',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED),
  },
  windows_open: {
    topic: 'windows_open',
    parse: boolean,
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.WINDOW_OPENED),
  },
  tyre_front_left: {
    topic: 'tpms_pressure_fl',
    parse: number({ min: 0, max: 10, decimals: 2 }),
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE, {
      unit: U.BAR,
      max: 10,
      kind: 'measurement',
    }),
  },
  tyre_front_right: {
    topic: 'tpms_pressure_fr',
    parse: number({ min: 0, max: 10, decimals: 2 }),
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE, {
      unit: U.BAR,
      max: 10,
      kind: 'measurement',
    }),
  },
  tyre_rear_left: {
    topic: 'tpms_pressure_rl',
    parse: number({ min: 0, max: 10, decimals: 2 }),
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE, {
      unit: U.BAR,
      max: 10,
      kind: 'measurement',
    }),
  },
  tyre_rear_right: {
    topic: 'tpms_pressure_rr',
    parse: number({ min: 0, max: 10, decimals: 2 }),
    ...feature(C.ELECTRICAL_VEHICLE_STATE, T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE, {
      unit: U.BAR,
      max: 10,
      kind: 'measurement',
    }),
  },
  state: {
    topic: 'state',
    // TeslaMate's own words: online, asleep, offline, charging, driving, updating...
    parse: text({ pattern: /^[a-z_]{2,20}$/ }),
    ...feature(C.TEXT, T.TEXT.TEXT, { kind: 'text' }),
  },
  geofence: {
    topic: 'geofence',
    parse: text({ empty: true }),
    ...feature(C.TEXT, T.TEXT.TEXT, { kind: 'text', option: 'publishGeofence' }),
  },
  position: {
    topic: 'location',
    parse: roundedPosition,
    ...feature(C.TEXT, T.TEXT.TEXT, { kind: 'text', option: 'publishPosition' }),
  },
};

/** The order of the features in a device (the one of FEATURES). */
export const FEATURE_KEYS = Object.keys(FEATURES);

/** Topic suffix -> feature key. */
export const BY_TOPIC = new Map(Object.entries(FEATURES).map(([key, f]) => [f.topic, key]));

/** Topics read for the car itself, not as features. */
export const META_TOPICS = new Set(['display_name', 'since', 'healthy', 'model', 'vin']);

/** Whether a feature may be read and published with this configuration. */
export const allowed = (key, config) => {
  const option = FEATURES[key]?.option;
  return option === undefined || config[option] === true;
};

/** The car id (TeslaMate's `$car_id`) of a topic level: digits, from 1. */
export const isCarId = (level) =>
  typeof level === 'string' && new RegExp(`^[1-9]\\d{0,${LIMITS.carIdDigits - 1}}$`).test(level);

/**
 * "<prefix><car_id>/<suffix>" -> { carId, suffix }, or undefined: one level
 * after the car id, never deeper (the topics of TeslaMate have none).
 */
export function parseTopic(topic, prefix) {
  if (typeof topic !== 'string' || !topic.startsWith(prefix)) {
    return undefined;
  }
  const rest = topic.slice(prefix.length).split('/');
  if (rest.length !== 2 || !isCarId(rest[0]) || !/^[a-z_]{1,40}$/.test(rest[1])) {
    return undefined;
  }
  return { carId: rest[0], suffix: rest[1] };
}

/** The platform id of a car: "<namespace>-<car id>" ("default-1" without namespace). */
export const platformId = (namespace, carId) => `${namespace ?? DEFAULT_NAMESPACE_ID}-${carId}`;

/** The `model` topic: S, 3, X, Y, or anything short (Cybertruck...). */
export const parseModel = (raw) => text({ pattern: /^[A-Za-z0-9 ]{1,20}$/ })(raw)?.text;

/** The `display_name` topic. */
export const parseName = (raw) => text()(raw)?.text;

/** The `since` topic: an ISO 8601 date -> epoch ms, or undefined. */
export function parseSince(raw) {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The Gladys device of a car: the features of the topics seen (in the
 * FEATURES order), names in the configured language.
 */
export function buildDevice(gladys, { namespace, carId, name, model, features, sameAs }, language) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformId(namespace, carId));
  const names = FEATURE_NAMES[language === 'en' ? 'en' : 'fr'];
  const params = [{ name: 'TESLAMATE_CAR_ID', value: carId }];
  if (namespace) {
    params.push({ name: 'TESLAMATE_NAMESPACE', value: namespace });
  }
  if (model) {
    params.push({ name: 'TESLAMATE_MODEL', value: model });
  }
  if (sameAs) {
    // The same VIN under another car id: an old car of TeslaMate kept by the broker.
    params.push({ name: 'TESLAMATE_SAME_CAR_AS', value: sameAs });
  }
  return {
    name: name || `Tesla ${carId}`,
    external_id: ids.device,
    model: model ? `Tesla Model ${model}`.slice(0, 50) : 'Tesla',
    should_poll: false,
    params,
    features: FEATURE_KEYS.filter((key) => features.has(key)).map((key) => {
      const f = FEATURES[key];
      return {
        name: names[key],
        external_id: ids.feature(key),
        category: f.category,
        type: f.type,
        ...(f.unit ? { unit: f.unit } : {}),
        min: f.min,
        max: f.max,
        read_only: true,
        has_feedback: false,
        keep_history: f.kind !== 'text',
      };
    }),
  };
}
