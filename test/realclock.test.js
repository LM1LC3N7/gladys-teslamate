// -----------------------------------------------------------------------------
// The app on the REAL clock (sped up 20 times): the periods it keeps are
// measured, not assumed. Wide margins (a timer is late under load, never
// early); everything is stopped in t.after, so a failure never leaves a timer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { F, createdCar, setup, within } from './helpers/app.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';

test('real clock: the states leave every second, a measurement every 10 s', async (t) => {
  const clock = realClock({ speed: 20 });
  const device = createdCar({ features: ['battery_level', 'locked'] });
  const { gladys, mqtt, app } = await setup({ devices: [device], clock });
  let feeder;
  t.after(() => {
    clearInterval(feeder);
    app.stop();
    clock.close();
  });
  const flushes = spyOn(app.publisher, 'doFlush', clock);
  const sends = [];
  const original = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = (batch, options) => {
    if (batch.some((s) => s.device_feature_external_id === F('battery_level'))) {
      sends.push(clock.monotonic());
    }
    return original(batch, options);
  };
  // TeslaMate while charging: a new battery level every 0.4 s (simulated).
  let level = 20;
  feeder = setInterval(() => {
    level = level >= 99 ? 20 : level + 1;
    mqtt.last.deliver('teslamate/cars/1/battery_level', String(level));
  }, 20);
  await within(measurePeriod(flushes, { count: 4, period: TIMINGS.flushInterval }), 10_000);
  const deadline = performance.now() + 8000;
  while (sends.length < 4 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(sends.length >= 4, `${sends.length} sends`);
  const gaps = sends.slice(1, 4).map((v, i) => v - sends[i]);
  for (const gap of gaps) {
    assert.ok(
      gap >= TIMINGS.measurementInterval * 0.99 && gap <= TIMINGS.measurementInterval * 1.5,
      `gaps ${gaps.map(Math.round).join(', ')} ms`,
    );
  }
});
