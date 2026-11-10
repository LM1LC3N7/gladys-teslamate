// -----------------------------------------------------------------------------
// The integration: one connection to the MQTT broker of the user, where
// TeslaMate publishes the data of each car (docs.teslamate.org, "MQTT
// Integration"); each car turned into a Gladys device (src/car.js), its
// values sent within the Gladys rate limit (src/publisher.js), the transport
// badge and the "Test the connection" button. READ ONLY: nothing is ever
// published on the broker, no command reaches a car. index.js only wires the
// SDK handlers (src/handlers.js).
//
// Freshness (a broker keeps the last value of every topic, "retained", maybe
// from long ago):
//   - a value arriving live (not retained) is current: sent at once;
//   - a retained value (at subscription, after a restart or a reconnection)
//     is never sent as new: equal to what Gladys has, nothing is sent; else
//     it is sent DATED (created_at, which starts no scene): just after the
//     last change Gladys knows of that feature, or, for a feature without any
//     value yet, at the `since` of the car (the date of its last state
//     change); without such a date, nothing is sent until a live value;
//   - a reconnection to Gladys never sends a value again (Gladys has them);
//   - the odometer never goes down: a lower value is ignored.
//
// Failures (lessons of the previous waves, as gladys-qbus):
//   - credentials refused by the broker: the client stops, a stop persisted
//     in /data, next tries 15 min, 1 h, 6 h then every 24 h, never in a loop;
//     saving other credentials or "Test the connection" tries again;
//   - broker unreachable: mqtt.js tries again every 10 s (a local broker);
//   - a CONNECT with credentials closed or left unanswered once the transport
//     opened, twice in a row: counted like refused credentials;
//   - messages bounded before they are read (src/mqtt.js);
//   - the configuration unreadable from Gladys: tried again, spaced, without end;
//   - a reconnection to Gladys keeps the MQTT client and the stop, and only
//     re-sends the status, the Discovery and the badges.
// Clocks: `now` (wall) dates the states and what /data keeps; `monotonic`
// paces the stop after a refusal, the test cooldown and the publisher.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  BY_TOPIC,
  FEATURES,
  META_TOPICS,
  allowed,
  buildDevice,
  parseModel,
  parseName,
  parseSince,
  parseTopic,
  platformId,
} from './car.js';
import { connectionKey, credentialsKey, normalizeConfig, topicPrefix } from './config.js';
import { DEVICE_TYPE, LIMITS, TIMINGS } from './constants.js';
import { T, TEST, UNHEALTHY, age } from './i18n.js';
import { connectBroker, errorReason, isProtocolRefusal, isRefusal } from './mqtt.js';
import { StatePublisher } from './publisher.js';
import { authWait, fileStore, normalizeMemory, serializeMemory } from './store.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The features behind an option of the configuration. */
const OPTIONAL = ['geofence', 'position'];

/** The text of a payload, or undefined (too large, not UTF-8). */
function payloadText(payload) {
  if (!payload || payload.length > LIMITS.payloadBytes) {
    return undefined;
  }
  try {
    return decoder.decode(payload);
  } catch {
    return undefined;
  }
}

const sameValue = (a, b) =>
  a !== undefined && b !== undefined && a.state === b.state && a.text === b.text;

/** How long /data may take to answer at start: past it, no stop is known. */
const STORE_TIMEOUT = 5000;
/** /data unreadable at start: read again this often, at most MEMORY_TRIES times. */
const MEMORY_RETRY = 10_000;
const MEMORY_TRIES = 6;
/** Failed connection attempts in a row before the slow pace. */
const RECONNECT_SLOW_AFTER = 3;

export class TeslaMateApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'teslamate' }),
    connect = connectBroker,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.config = normalizeConfig();
    this.rawConfig = {};
    this.connKey = undefined;
    this.credKey = undefined;
    this.memory = undefined;
    /** Monotonic time before which no connection is tried (refused credentials). */
    this.authDue = 0;
    this.client = null;
    this.generation = 0;
    this.started = false;
    this.stopped = false;
    this.protocolVersion = 5;
    this.lastError = undefined;
    this.unanswered = 0;
    this.wasConnected = false;
    this.configTries = 0;
    /** A salt for the VIN fingerprints, never stored: they only live in memory. */
    this.salt = randomBytes(16);
    this.resetCars();
    /**
     * featureId -> { value, at }: the latest value sent to Gladys. Kept across
     * restarts of the connection: the devices of Gladys in memory do not
     * follow what was sent since they were read.
     */
    this.known = new Map();
    this.created = new Set();
    this.lastStatus = undefined;
    this.lastStatusArgs = undefined;
    this.publishedDevices = undefined;
    /** deviceId -> transport key last published */
    this.transports = new Map();
    this.timersById = {};
    this.warned = new Set();
    this.lastTest = undefined;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
  }

  resetCars() {
    /** carId -> { name, model, since, healthy, vin, features: Set } */
    this.cars = new Map();
    /** car ids seen beyond LIMITS.cars */
    this.capped = new Set();
    /** featureId -> { value, at (wall ms) | undefined, retained, carId } : the latest read */
    this.latest = new Map();
    /** featureIds of retained values waiting for the end of the burst */
    this.pendingRetained = new Set();
    this.dataSeen = false;
  }

  // --- Memory (/data) ----------------------------------------------------------

  /**
   * The state of /data, read once: true when known (read, or no file). A
   * read slower than STORE_TIMEOUT or failing (EIO...) is NOT "empty": false
   * is returned and the caller tries again later. One read at a time: a slow
   * read still running is waited for again, never doubled, and its answer
   * counts even when it comes late.
   */
  async loadMemory() {
    if (this.memory) {
      return true;
    }
    if (!this.reading) {
      this.reading = this.store.load().then(
        (raw) => {
          this.reading = undefined;
          this.applyMemory(raw);
          return true;
        },
        (err) => {
          this.reading = undefined;
          this.warnOnce(`data:${err?.code}`, `Reading /data failed: ${err?.code ?? err?.message}`);
          return false;
        },
      );
    }
    let timer;
    const read = await Promise.race([
      this.reading,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(false), STORE_TIMEOUT);
      }),
    ]);
    this.timers.clearTimeout(timer);
    return read || Boolean(this.memory);
  }

  applyMemory(raw) {
    if (this.memory) {
      return;
    }
    const now = this.now();
    this.memory = normalizeMemory(raw, now);
    this.memoryWritable = true;
    this.authDue =
      this.memory.auth.until > now ? this.monotonic() + (this.memory.auth.until - now) : 0;
  }

  async saveMemory() {
    if (!this.memoryWritable) {
      // /data was never read: writing would overwrite a stop we do not know.
      return;
    }
    try {
      await this.store.save(serializeMemory(this.memory));
    } catch (err) {
      this.logger.warn(`Saving the state in /data failed: ${err.message}`);
    }
  }

  // --- Timers ------------------------------------------------------------------

  later(name, delay, fn) {
    this.timers.clearTimeout(this.timersById[name]);
    const generation = this.generation;
    this.timersById[name] = this.timers.setTimeout(() => {
      this.timersById[name] = undefined;
      if (generation === this.generation && !this.stopped) {
        Promise.resolve()
          .then(fn)
          .catch((err) => this.logger.error(`${name} failed: ${err.message}`));
      }
    }, delay);
  }

  /** Every timer, but the retry of the configuration read unless `all` (the final stop). */
  clearTimers({ all = true } = {}) {
    const kept = all ? undefined : this.timersById.getConfig;
    for (const [name, id] of Object.entries(this.timersById)) {
      if (name !== 'getConfig' || all) {
        this.timers.clearTimeout(id);
      }
    }
    this.timersById = kept === undefined ? {} : { getConfig: kept };
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Gladys (re)connected: the configuration read (tried again, spaced,
   * without end, while Gladys does not answer), then the status, the
   * Discovery and the badges again, the MQTT client kept when nothing changed.
   */
  async gladysConnected() {
    if (this.stopped) {
      return;
    }
    this.timers.clearTimeout(this.timersById.getConfig);
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped) {
        return;
      }
      const retry = TIMINGS.configRetry;
      const wait = retry[Math.min(this.configTries, retry.length - 1)];
      this.configTries += 1;
      this.logger.warn(`Reading the configuration failed: ${err.message}`);
      await this.setStatus(false, T.configUnread(age(wait)), { force: true, remember: false });
      // Its own timer, outside the generations: only the final stop cancels
      // it (clearTimers keeps it), a start() meanwhile never does.
      this.timersById.getConfig = this.timers.setTimeout(() => {
        this.timersById.getConfig = undefined;
        this.gladysConnected().catch((e) => this.logger.error(`getConfig: ${e.message}`));
      }, wait);
      return;
    }
    if (this.stopped) {
      return;
    }
    this.configTries = 0;
    await this.refreshDevices();
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      await this.applySoft(next, raw);
      await this.eraseDisallowed();
      this.publishedDevices = undefined;
      this.transports.clear();
      // The last status again (it was lost with Gladys), then what is known now.
      if (this.lastStatusArgs) {
        await this.setStatus(...this.lastStatusArgs, { force: true });
      }
      await this.updateStatus();
      await this.rebuild({ force: true });
      return;
    }
    await this.start(raw);
  }

  /** Saved by the user: options apply at once; a new broker, namespace or credentials reconnect. */
  async configUpdated(raw) {
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      await this.applySoft(next, raw);
      await this.rebuild();
      await this.updateStatus();
      return;
    }
    await this.start(raw);
  }

  /** The options that need no reconnection: language, geofence and position. */
  async applySoft(next, raw) {
    const before = this.config;
    this.rawConfig = raw ?? {};
    this.config = next;
    let turnedOn = false;
    for (const key of OPTIONAL) {
      if (allowed(key, before) && !allowed(key, next)) {
        await this.withdraw(key);
      } else if (!allowed(key, before) && allowed(key, next)) {
        turnedOn = true;
      }
    }
    if (turnedOn) {
      this.resubscribe();
    }
  }

  /**
   * An option turned off (position, geofence): the values read are dropped,
   * nothing more is sent, and the value Gladys shows is erased ('').
   */
  async withdraw(key) {
    // What was read is dropped, nothing of it is sent any more...
    for (const [carId, car] of this.cars) {
      car.features.delete(key);
      const id = this.featureId(carId, key);
      this.latest.delete(id);
      this.pendingRetained.delete(id);
      this.publisher.pending.delete(id);
    }
    // ...and every created feature of that kind (a car seen since the start
    // or not) shows an empty text instead of its last value.
    for (const device of this.gladys.devices ?? []) {
      if (!this.isOurs(device)) {
        continue;
      }
      for (const feature of device.features ?? []) {
        const id = feature.external_id;
        if (typeof id !== 'string' || !id.endsWith(`:${key}`)) {
          continue;
        }
        const known = this.knownOf(id);
        if (known && known.value.text !== '') {
          this.publisher.push(id, { text: '' });
          this.known.set(id, { value: { text: '' }, at: this.now() });
        }
      }
    }
  }

  /**
   * The values of an option that is off are erased in Gladys, whenever the
   * option was turned off (even while the integration was not running):
   * at every start and every connection to Gladys. Idempotent.
   */
  async eraseDisallowed() {
    for (const key of OPTIONAL) {
      if (!allowed(key, this.config)) {
        await this.withdraw(key);
      }
    }
  }

  /**
   * An option turned on: the same subscription again. A broker MUST then
   * send its retained values once more (MQTT 3.1.1 3.8.4, MQTT 5 with the
   * default retain handling); they go the dated way, never as new.
   */
  resubscribe() {
    const client = this.client;
    if (!client?.connected) {
      return;
    }
    client.subscribe([`${topicPrefix(this.config)}+/+`], { qos: 0 }, (err) => {
      if (err) {
        this.logger.warn(`Subscription failed: ${err.message}`);
      }
    });
  }

  isOurs(device) {
    return (
      typeof device?.external_id === 'string' &&
      device.external_id.startsWith(this.gladys.externalId(`${DEVICE_TYPE}:`))
    );
  }

  async start(raw = {}) {
    if (this.stopped) {
      return;
    }
    this.stop({ final: false });
    const generation = this.generation;
    this.started = true;
    this.rawConfig = raw ?? {};
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    this.wasConnected = false;
    this.protocolVersion = 5;
    this.lastError = undefined;
    this.unanswered = 0;
    this.failedAttempts = 0;
    this.resetCars();
    this.publishedDevices = undefined;
    this.transports.clear();
    this.publisher.clear();
    // The devices Gladys sent with its last synchronization: the values of
    // the created features go out even if the configuration read failed.
    this.refreshCreated();
    // Gladys is reached whatever the broker does: the erasures below and the
    // values leave even while the broker is stopped or unreachable.
    this.publisher.start();
    await this.eraseDisallowed();
    if (this.config.problem) {
      await this.setStatus(false, T.problem(this.config.problem));
      return;
    }
    if (!(await this.loadMemory())) {
      if (generation !== this.generation) {
        return;
      }
      this.memoryTries = (this.memoryTries ?? 0) + 1;
      if (this.memoryTries < MEMORY_TRIES) {
        await this.setStatus(false, T.dataUnreadable(age(MEMORY_RETRY)));
        this.later('memory', MEMORY_RETRY, () => this.start(this.rawConfig));
        return;
      }
      // Still unreadable after a minute: go on without the stop it may hold,
      // never writing over it (saveMemory stays off until a read succeeds).
      this.logger.warn('/data still unreadable: connecting without its state');
      this.memory = normalizeMemory(null, this.now());
      this.memoryWritable = false;
    }
    if (generation !== this.generation) {
      return;
    }
    const credentials = credentialsKey(this.config);
    if (
      this.credKey !== undefined &&
      credentials !== this.credKey &&
      this.memory.auth.failures > 0
    ) {
      // Other credentials: the stop on the refused ones is lifted.
      this.memory.auth = { failures: 0, until: 0 };
      this.authDue = 0;
      await this.saveMemory();
    }
    this.credKey = credentials;
    const wait = this.authDue - this.monotonic();
    if (wait > 0) {
      await this.setStatus(false, T.stopped(age(wait)));
      this.later('auth', wait, () => this.connectNow());
      return;
    }
    await this.connectNow();
  }

  async connectNow() {
    const generation = this.generation;
    await this.setStatus(false, T.connecting);
    if (generation !== this.generation) {
      return;
    }
    // A CONNECT left without CONNACK, armed once the transport opened (only
    // then may the credentials have left), cleared by a CONNACK.
    const UNANSWERED = 'the broker closed the connection without answering';
    let pending;
    let opened = false;
    const hooks = {
      onAttempt: () => {
        pending = undefined;
        opened = false;
      },
      onOpen: () => {
        opened = true;
        pending = UNANSWERED;
      },
    };
    let client;
    try {
      client = this.connect(this.config, { protocolVersion: this.protocolVersion, ...hooks });
    } catch (err) {
      this.lastError = errorReason(err);
      await this.setStatus(false, T.unreachable(this.lastError));
      return;
    }
    this.client = client;
    const current = () => generation === this.generation && this.client === client;
    // The reconnection pace: 10 s, then 60 s after RECONNECT_SLOW_AFTER failed
    // attempts in a row (a wrong address, a broker down for the night).
    let fastPeriod = client.options?.reconnectPeriod;
    this.retryPeriod = fastPeriod ?? TIMINGS.reconnectPeriod;
    client.on('packetreceive', (packet) => {
      if (packet?.cmd === 'connack') {
        pending = undefined;
      }
    });
    client.on('connect', () => {
      if (current()) {
        this.unanswered = 0;
        this.lastError = undefined;
        this.failedAttempts = 0;
        if (client.options && fastPeriod !== undefined) {
          client.options.reconnectPeriod = fastPeriod;
        }
        this.onConnect().catch((err) => this.logger.error(`After connection: ${err.message}`));
      }
    });
    client.on('message', (topic, payload, packet) => {
      if (current()) {
        try {
          this.onMessage(topic, payload, packet);
        } catch (err) {
          // One odd message never stops the others.
          this.warnOnce(`message:${err.message}`, `A message was ignored: ${err.message}`);
        }
      }
    });
    client.on('error', (err) => {
      if (!current()) {
        return;
      }
      let reason = errorReason(err);
      if (err?.message === 'connack timeout' && !opened) {
        reason = 'no answer from the broker at the network level';
      }
      this.lastError = reason;
      if (isRefusal(err)) {
        this.onRefused(reason).catch((e) => this.logger.error(`After a refusal: ${e.message}`));
        return;
      }
      if (isProtocolRefusal(err) && this.protocolVersion === 5) {
        this.onProtocolRefused().catch((e) => this.logger.error(`MQTT 3.1.1: ${e.message}`));
        return;
      }
      if (err?.message === 'connack timeout' && pending) {
        pending = 'no answer from the broker to the connection';
      }
      this.warnOnce(`broker:${reason}`, `MQTT broker: ${reason}`);
      this.setStatus(false, T.unreachable(reason, age(this.retryPeriod)));
    });
    client.on('close', () => {
      if (!current()) {
        return;
      }
      if (!this.wasConnected) {
        this.failedAttempts += 1;
        if (this.failedAttempts >= RECONNECT_SLOW_AFTER && client.options) {
          fastPeriod ??= client.options.reconnectPeriod;
          client.options.reconnectPeriod = TIMINGS.reconnectSlow;
          this.retryPeriod = TIMINGS.reconnectSlow;
        }
      }
      if (pending) {
        const reason = pending;
        pending = undefined;
        this.onUnanswered(reason).catch((e) => this.logger.error(`Unanswered: ${e.message}`));
        return;
      }
      if (this.wasConnected) {
        this.wasConnected = false;
        this.timers.clearTimeout(this.timersById.noData);
        this.setStatus(
          false,
          this.lastError ? T.unreachable(this.lastError, age(this.retryPeriod)) : T.lost,
        );
        this.publishAllTransports().catch(() => {});
      }
    });
  }

  /** A CONNECT with credentials closed or unanswered, twice in a row: like a refusal. */
  async onUnanswered(reason) {
    this.lastError = reason;
    this.unanswered += 1;
    if (this.hasCredentials() && this.unanswered >= 2) {
      this.unanswered = 0;
      await this.onRefused(`${reason}, twice`);
      return;
    }
    this.warnOnce(`broker:${reason}`, `MQTT broker: ${reason}`);
    await this.setStatus(false, T.unreachable(reason, age(this.retryPeriod)));
  }

  hasCredentials() {
    return Boolean(this.config.username || this.config.password);
  }

  /** The broker does not speak MQTT 5: 3.1.1, with the size guard of src/mqtt.js only. */
  async onProtocolRefused() {
    this.logger.warn('The MQTT broker does not support MQTT 5: using MQTT 3.1.1');
    this.endClient();
    this.protocolVersion = 4;
    await this.connectNow();
  }

  /** The broker refused the credentials: stop, and try again later (persisted). */
  async onRefused(reason) {
    const generation = this.generation;
    this.logger.warn(`MQTT broker refused the connection: ${reason}`);
    this.endClient();
    const failures = this.memory.auth.failures + 1;
    const wait = authWait(failures);
    this.memory.auth = { failures, until: this.now() + wait };
    this.authDue = this.monotonic() + wait;
    await this.saveMemory();
    if (generation !== this.generation) {
      return;
    }
    await this.setStatus(false, T.refused(reason, age(wait)));
    this.later('auth', wait, () => this.connectNow());
  }

  endClient() {
    if (this.client) {
      this.client.removeAllListeners?.();
      this.client.on?.('error', () => {});
      this.client.end(true);
      this.client = null;
    }
  }

  /** `final`: the container stops (handleShutdown); otherwise a restart follows. */
  stop({ final = true } = {}) {
    this.generation += 1;
    this.clearTimers({ all: final });
    this.publisher.stop();
    this.endClient();
    if (final) {
      this.stopped = true;
    }
  }

  /** `remember: false`: a passing status, not the one sent again after a reconnection. */
  async setStatus(connected, message, { force = false, remember = true } = {}) {
    const key = JSON.stringify([connected, message ?? null]);
    if (!force && key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    if (remember) {
      this.lastStatusArgs = [connected, message];
    }
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  warnOnce(key, message) {
    if (this.warned.size < 200 && !this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  async onConnect() {
    const generation = this.generation;
    this.logger.info(
      `Connected to the MQTT broker ${this.config.brokerUrl} (MQTT ${this.protocolVersion === 5 ? '5' : '3.1.1'})`,
    );
    this.wasConnected = true;
    if (this.memory.auth.failures > 0) {
      this.memory.auth = { failures: 0, until: 0 };
      this.authDue = 0;
      await this.saveMemory();
    }
    if (generation !== this.generation || !this.client) {
      return;
    }
    // A clean session: subscribe again; the broker sends the retained values.
    this.client.subscribe([`${topicPrefix(this.config)}+/+`], { qos: 0 }, (err) => {
      if (err) {
        this.logger.warn(`Subscription failed: ${err.message}`);
      }
    });
    this.later('noData', TIMINGS.noDataAfter, () => this.updateStatus());
    await this.updateStatus();
    await this.publishAllTransports();
  }

  /** The status from what is known now. */
  async updateStatus() {
    if (this.config.problem) {
      return this.setStatus(false, T.problem(this.config.problem));
    }
    if (!this.client?.connected) {
      return undefined;
    }
    const prefix = topicPrefix(this.config);
    if (this.cars.size === 0) {
      return this.setStatus(
        false,
        this.timersById.noData === undefined ? T.noData(prefix) : T.waiting(prefix),
      );
    }
    const unhealthy = [...this.cars.values()].filter((c) => c.healthy === false).length;
    return this.setStatus(
      true,
      T.connected(this.cars.size, {
        unhealthy,
        capped: this.capped.size,
        protocol3: this.protocolVersion !== 5,
      }),
    );
  }

  // --- Messages --------------------------------------------------------------------

  featureId(carId, key) {
    return this.gladys
      .externalIds(DEVICE_TYPE, platformId(this.config.namespace, carId))
      .feature(key);
  }

  deviceId(carId) {
    return this.gladys.externalIds(DEVICE_TYPE, platformId(this.config.namespace, carId)).device;
  }

  carOf(carId) {
    let car = this.cars.get(carId);
    if (car) {
      return car;
    }
    if (this.cars.size >= LIMITS.cars) {
      if (this.capped.size < 1000) {
        this.capped.add(carId);
      }
      return undefined;
    }
    car = {
      name: undefined,
      model: undefined,
      since: undefined,
      healthy: undefined,
      vin: undefined,
      features: new Set(),
    };
    this.cars.set(carId, car);
    this.scheduleRebuild();
    return car;
  }

  onMessage(topic, payload, packet) {
    const info = parseTopic(topic, topicPrefix(this.config));
    if (!info) {
      return;
    }
    const isMeta = META_TOPICS.has(info.suffix);
    const key = BY_TOPIC.get(info.suffix);
    if (!isMeta && (key === undefined || !allowed(key, this.config))) {
      // Not read (navigation, speed...) or turned off (position): never kept.
      return;
    }
    const text = payloadText(payload);
    if (text === undefined) {
      this.warnOnce(
        `payload:${info.suffix}`,
        `A value of ${info.suffix} was ignored (size, encoding)`,
      );
      return;
    }
    const car = this.carOf(info.carId);
    if (!car) {
      this.updateStatus().catch(() => {});
      return;
    }
    if (!this.dataSeen) {
      this.dataSeen = true;
      this.timers.clearTimeout(this.timersById.noData);
      this.timersById.noData = undefined;
    }
    if (isMeta) {
      this.onMeta(info.carId, car, info.suffix, text);
      return;
    }
    const value = FEATURES[key].parse(text);
    if (value === undefined) {
      // Empty (the car reports nothing) or not readable: unknown, the last value stays.
      return;
    }
    if (!car.features.has(key)) {
      car.features.add(key);
      this.scheduleRebuild();
    }
    this.record(info.carId, key, value, packet?.retain === true);
  }

  onMeta(carId, car, suffix, text) {
    if (suffix === 'display_name') {
      const name = parseName(text);
      if (name !== undefined && name !== car.name) {
        car.name = name;
        this.scheduleRebuild();
      }
    } else if (suffix === 'model') {
      const model = parseModel(text);
      if (model !== undefined && model !== car.model) {
        car.model = model;
        this.scheduleRebuild();
      }
    } else if (suffix === 'since') {
      const since = parseSince(text);
      if (since !== undefined) {
        car.since = since;
      }
    } else if (suffix === 'healthy') {
      const healthy = text === 'true' ? true : text === 'false' ? false : undefined;
      if (healthy !== undefined && healthy !== car.healthy) {
        car.healthy = healthy;
        this.updateStatus().catch(() => {});
        this.publishAllTransports().catch(() => {});
      }
    } else if (suffix === 'vin') {
      // Only a salted fingerprint, in memory: the VIN identifies the car and its owner.
      const vin = text.trim();
      const fingerprint = /^[A-Z0-9]{11,17}$/.test(vin)
        ? createHash('sha256').update(this.salt).update(vin).digest('hex').slice(0, 16)
        : undefined;
      if (fingerprint !== car.vin) {
        car.vin = fingerprint;
        this.scheduleRebuild();
      }
    }
  }

  /** A value read: sent now when live, held for the end of the burst when retained. */
  record(carId, key, value, retained) {
    const id = this.featureId(carId, key);
    if (FEATURES[key].kind === 'counter') {
      const known = this.knownOf(id)?.value.state;
      const latest = this.latest.get(id)?.value.state;
      const highest = Math.max(known ?? -Infinity, latest ?? -Infinity);
      if (value.state < highest) {
        this.warnOnce(`counter:${id}`, `A lower ${key} was ignored (it never goes down)`);
        return;
      }
    }
    if (retained) {
      this.latest.set(id, { value, at: undefined, retained: true, carId });
      this.pendingRetained.add(id);
      this.later('retained', TIMINGS.retainedSettle, () => this.flushRetained());
      return;
    }
    const at = this.now();
    this.latest.set(id, { value, at, retained: false, carId });
    this.pendingRetained.delete(id);
    if (this.created.has(id)) {
      this.publisher.push(id, value, { throttle: FEATURES[key].kind === 'measurement' });
      this.known.set(id, { value, at });
    }
  }

  /** The end of a burst of retained values: the created features get the new ones, dated. */
  flushRetained() {
    for (const id of this.pendingRetained) {
      if (this.created.has(id)) {
        this.sendDated(id);
      }
    }
    this.pendingRetained.clear();
  }

  /**
   * The latest value of a feature, sent dated (never as new): just after
   * the last change Gladys knows of, or at the `since` of the car for a
   * feature without value; nothing when equal to what Gladys has, or when no
   * date can be given.
   */
  sendDated(id) {
    const latest = this.latest.get(id);
    if (!latest) {
      return;
    }
    const known = this.knownOf(id);
    if (known && sameValue(known.value, latest.value)) {
      return;
    }
    const now = this.now();
    let at;
    if (!latest.retained) {
      at = latest.at;
    } else if (known) {
      at = known.at === undefined ? undefined : known.at + 1;
    } else {
      at = this.cars.get(latest.carId)?.since;
    }
    if (at === undefined || !Number.isFinite(at)) {
      return;
    }
    at = Math.min(at, now);
    this.publisher.push(id, { ...latest.value, created_at: new Date(at).toISOString() });
    this.known.set(id, { value: latest.value, at });
  }

  /** What Gladys has of a feature: the last value sent, else the one of its device. */
  knownOf(id) {
    const sent = this.known.get(id);
    if (sent) {
      return sent;
    }
    const feature = this.gladysFeatures?.get(id);
    if (!feature) {
      return undefined;
    }
    const changed = Date.parse(feature.last_value_changed ?? '');
    const at = Number.isFinite(changed) ? changed : undefined;
    if (feature.category === 'text') {
      return typeof feature.last_value_string === 'string'
        ? { value: { text: feature.last_value_string }, at }
        : undefined;
    }
    return typeof feature.last_value === 'number' && Number.isFinite(feature.last_value)
      ? { value: { state: feature.last_value }, at }
      : undefined;
  }

  // --- Devices -----------------------------------------------------------------------

  /** The devices of Gladys, read again (their features and last values). */
  async refreshDevices() {
    await this.gladys.getDevices?.().catch(() => undefined);
    this.refreshCreated();
  }

  refreshCreated() {
    this.gladysFeatures = new Map();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        if (typeof feature.external_id === 'string') {
          this.gladysFeatures.set(feature.external_id, feature);
        }
      }
    }
    this.created = new Set(this.gladysFeatures.keys());
  }

  scheduleRebuild() {
    this.later('rebuild', TIMINGS.discoveryDebounce, () => this.rebuild());
  }

  /** The cars of TeslaMate as Gladys devices (Discovery), then the status and the badges. */
  async rebuild({ force = false } = {}) {
    const devices = [];
    for (const [carId, car] of this.cars) {
      if (car.features.size === 0) {
        continue;
      }
      const sameAs = car.vin
        ? [...this.cars].find(([id, other]) => id !== carId && other.vin === car.vin)?.[0]
        : undefined;
      devices.push(
        buildDevice(
          this.gladys,
          {
            namespace: this.config.namespace,
            carId,
            name: car.name,
            model: car.model,
            features: car.features,
            sameAs,
          },
          this.config.language,
        ),
      );
    }
    const list = this.keepCreatedFeatures(devices);
    const json = JSON.stringify(list);
    if (force || json !== this.publishedDevices) {
      this.publishedDevices = json;
      await this.gladys
        .publishDiscoveredDevices(list)
        .catch((err) => this.logger.warn(`Publishing the devices failed: ${err.message}`));
    }
    await this.updateStatus();
    await this.publishAllTransports();
  }

  /**
   * A device the user created never loses a feature (the core would show
   * "Update" and drop its history): the features of the created device that
   * the new build lacks are kept as they are.
   */
  keepCreatedFeatures(devices) {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    return devices.map((device) => {
      const old = created.get(device.external_id);
      if (!old) {
        return device;
      }
      const ids = new Set(device.features.map((f) => f.external_id));
      const kept = (old.features ?? [])
        .filter((f) => typeof f.external_id === 'string' && !ids.has(f.external_id))
        .map((f) => {
          const copy = {};
          for (const key of [
            'name',
            'external_id',
            'category',
            'type',
            'unit',
            'min',
            'max',
            'read_only',
            'has_feedback',
            'keep_history',
          ]) {
            if (f[key] !== undefined && f[key] !== null) {
              copy[key] = f[key];
            }
          }
          return copy;
        });
      return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
    });
  }

  /** The user created (or updated) a device: the values read so far are sent, dated. */
  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const feature of device?.features ?? []) {
      const id = feature?.external_id;
      if (typeof id === 'string' && this.latest.has(id) && !this.pendingRetained.has(id)) {
        this.sendDated(id);
      }
    }
    await this.publishAllTransports().catch(() => {});
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (typeof device?.external_id === 'string') {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
      for (const id of this.known.keys()) {
        if (id.startsWith(`${device.external_id}:`)) {
          this.known.delete(id);
        }
      }
    }
  }

  /** Gladys asks for the devices: the list now. */
  async scan() {
    await this.rebuild({ force: true });
  }

  // --- Transport badge -------------------------------------------------------------------

  transportOf(deviceId) {
    if (!this.client?.connected) {
      return { external_id: deviceId, transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    const carId = [...this.cars.keys()].find((id) => this.deviceId(id) === deviceId);
    if (carId !== undefined && this.cars.get(carId).healthy === false) {
      return {
        external_id: deviceId,
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: UNHEALTHY,
      };
    }
    return { external_id: deviceId, transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishAllTransports() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      if (!this.isOurs(device)) {
        continue;
      }
      const entry = this.transportOf(device.external_id);
      const key = JSON.stringify(entry);
      if (this.transports.get(device.external_id) !== key) {
        this.transports.set(device.external_id, key);
        entries.push(entry);
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  // --- The "Test the connection" button ---------------------------------------------------

  async testConnection() {
    // The cooldown first: a burst of clicks never reaches the broker either.
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TIMINGS.testCooldown) {
      return TEST.tooSoon;
    }
    this.lastTest = mono;
    // The saved configuration as it is now (never an older copy).
    const raw = await this.gladys.getConfig().catch(() => this.rawConfig ?? {});
    const config = normalizeConfig(raw);
    if (config.problem) {
      return T.problem(config.problem);
    }
    const prefix = topicPrefix(config);
    const answer = await new Promise((resolve) => {
      let probe;
      let timer;
      let done = false;
      const names = new Map();
      const finish = (result) => {
        if (done) {
          return;
        }
        done = true;
        this.timers.clearTimeout(timer);
        if (probe) {
          probe.removeAllListeners?.();
          probe.on?.('error', () => {});
          probe.end(true);
        }
        resolve(result);
      };
      let protocolVersion = this.protocolVersion;
      const open = () => {
        try {
          probe = this.connect(config, { protocolVersion });
        } catch (err) {
          finish({ text: T.unreachable(errorReason(err)) });
          return;
        }
        probe.on('error', (err) => {
          if (isProtocolRefusal(err) && protocolVersion === 5) {
            protocolVersion = 4;
            probe.removeAllListeners?.();
            probe.on?.('error', () => {});
            probe.end(true);
            open();
            return;
          }
          const reason = errorReason(err);
          finish({ text: isRefusal(err) ? TEST.refused(reason) : T.unreachable(reason) });
        });
        probe.on('message', (topic, payload) => {
          const info = parseTopic(topic, prefix);
          if (!info || names.size >= LIMITS.cars) {
            return;
          }
          const text = info.suffix === 'display_name' ? payloadText(payload) : undefined;
          const name = text === undefined ? undefined : parseName(text);
          if (name !== undefined || !names.has(info.carId)) {
            names.set(info.carId, name ?? names.get(info.carId));
          }
        });
        probe.on('connect', () => {
          this.timers.clearTimeout(timer);
          timer = this.timers.setTimeout(() => {
            const list = [...names].map(([id, name]) => name ?? `Tesla ${id}`);
            finish({
              text: list.length > 0 ? TEST.ok(list) : TEST.none(prefix),
              reached: true,
            });
          }, TIMINGS.testListen);
          probe.subscribe([`${prefix}+/+`], { qos: 0 });
        });
      };
      timer = this.timers.setTimeout(
        () => finish({ text: T.unreachable('timeout') }),
        TIMINGS.connectTimeout + 1000,
      );
      open();
    });
    if (answer.reached && this.memory?.auth.failures > 0) {
      // The credentials work again: the stop is lifted and the integration reconnects.
      this.memory.auth = { failures: 0, until: 0 };
      this.authDue = 0;
      await this.saveMemory();
      await this.start(raw);
    }
    return answer.text;
  }
}
