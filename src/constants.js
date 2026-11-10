// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their scenes and
// configuration) and the tuning of the integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** The `type` part of the external ids: ext:<selector>:car:<namespace>-<car id> (forever). */
export const DEVICE_TYPE = 'car';

/** The namespace part of the ids when TeslaMate has none (MQTT_NAMESPACE unset). */
export const DEFAULT_NAMESPACE_ID = 'default';

export const LIMITS = {
  /** Gladys accepts 300 states per minute: a margin for the other paths. */
  statesPerMinute: 250,
  /** The largest MQTT packet accepted from the broker (TeslaMate values are a few bytes). */
  packetBytes: 64 * 1024,
  /** A payload read as a value: TeslaMate's longest (active_route) is under 1 KB. */
  payloadBytes: 4096,
  /** Cars followed at once (TeslaMate numbers them from 1). */
  cars: 20,
  /** The longest car id read in a topic (digits). */
  carIdDigits: 6,
  /** Texts published (name, geofence, state). */
  text: 100,
  /** Namespace typed in the configuration (MQTT_NAMESPACE of TeslaMate). */
  namespace: 64,
};

/** Decimal places of the published position: 3 = about 110 m north-south, less east-west. */
export const POSITION_DECIMALS = 3;

export const TIMINGS = {
  /** Broker connection timeout. */
  connectTimeout: 10 * SECOND,
  /** Delay between two reconnection attempts to an unreachable broker. */
  reconnectPeriod: 10 * SECOND,
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** A measurement (battery, power, temperatures...) is sent at most this often per feature. */
  measurementInterval: 10 * SECOND,
  /** An unchanged value pushed again by TeslaMate is re-sent after this long. */
  stateHeartbeat: 30 * MINUTE,
  /** The retained messages arrive in a burst at subscription: handled once it ends. */
  retainedSettle: 1500,
  /** A new car or feature is published to Discovery after this pause. */
  discoveryDebounce: 2 * SECOND,
  /** No TeslaMate message this long after the subscription: the status says so. */
  noDataAfter: 30 * SECOND,
  /** How long the connection test waits for a first TeslaMate message. */
  testListen: 10 * SECOND,
  /** Two connection tests at least this far apart. */
  testCooldown: 10 * SECOND,
  /** After refused credentials: the next tries (the last one repeats). */
  authRetry: [15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR],
  /** The configuration could not be read from Gladys: next tries (the last one repeats). */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE, 5 * MINUTE],
};
