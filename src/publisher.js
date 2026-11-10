// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// TeslaMate publishes on every change (while charging, every few seconds).
// The publisher keeps the LAST value of each feature, sends the pending ones
// every second within a per-minute budget (LIMITS.statesPerMinute, the rest
// of the 300 left to the other paths), skips the unchanged ones
// (publishChangedStates) and spaces the measurements of a same feature by
// TIMINGS.measurementInterval. Doors, locks, states are never throttled, only
// budgeted. The budget and the spacing run on the monotonic clock: a wall
// clock set back or forward never stops nor hurries them.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({
    gladys,
    logger,
    monotonic = () => performance.now(),
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.monotonic = monotonic;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state | text, created_at? } */
    this.pending = new Map();
    /** featureId -> monotonic time of the last send */
    this.lastSent = new Map();
    /** monotonic send times of the last minute */
    this.window = [];
    this.throttled = new Set();
    this.timer = undefined;
    this.flushing = undefined;
    /** After a failed send: no new try before (monotonic), the wait doubling. */
    this.retryAt = -Infinity;
    this.backoff = 0;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.warnFailure(err));
    }, TIMINGS.flushInterval);
  }

  /** One warning, then at most one a minute while Gladys keeps failing. */
  warnFailure(err) {
    const now = this.monotonic();
    if (this.lastWarn === undefined || now - this.lastWarn >= 60_000) {
      this.lastWarn = now;
      this.logger.warn(`Sending the states failed: ${err.message}`);
    }
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The value of a feature to send; `throttle`: a measurement, spaced. */
  push(featureId, value, { throttle = false } = {}) {
    this.pending.set(featureId, value);
    if (throttle) {
      this.throttled.add(featureId);
    } else {
      this.throttled.delete(featureId);
    }
  }

  /** Forget a device (deleted): its pending values are dropped. */
  forget(deviceId) {
    for (const map of [this.pending, this.lastSent]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${deviceId}:`)) {
          map.delete(key);
        }
      }
    }
  }

  clear() {
    this.pending.clear();
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.monotonic();
    this.window = this.window.filter((t) => now - t < 60_000 && t <= now);
    let room = this.budget - this.window.length;
    if (room <= 0 || this.pending.size === 0 || now < this.retryAt) {
      return 0;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (room <= 0) {
        break;
      }
      const last = this.lastSent.get(featureId);
      if (
        this.throttled.has(featureId) &&
        last !== undefined &&
        now - last < TIMINGS.measurementInterval
      ) {
        continue;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    if (batch.length === 0) {
      return 0;
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (const entry of batch) {
        this.lastSent.set(entry.device_feature_external_id, now);
      }
      this.backoff = 0;
      this.retryAt = -Infinity;
      const count = Math.min(result?.count ?? batch.length, batch.length);
      for (let i = 0; i < count; i += 1) {
        this.window.push(now);
      }
      return count;
    } catch (err) {
      // Every state of the batch counts in the budget (Gladys may have taken
      // some), and the values are kept for the next round unless a newer one
      // arrived meanwhile.
      for (let i = 0; i < batch.length; i += 1) {
        this.window.push(now);
      }
      for (const entry of batch) {
        const { device_feature_external_id: id, ...value } = entry;
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      // Gladys down or refusing: the next try waits 5 s, doubling to 30 s.
      this.backoff = Math.min(Math.max(this.backoff * 2, 5000), 30_000);
      this.retryAt = now + this.backoff;
      throw err;
    }
  }
}
