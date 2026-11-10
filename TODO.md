# TODO — TeslaMate v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-10): read-only cars from the documented
      TeslaMate MQTT topics, Discovery of the topics seen, freshness of the
      retained values, geofence and rounded position options, namespace,
      refused credentials stop, MQTT 5 with 3.1.1 fallback, packet guard,
      "Test the connection", docs en/fr. Tested on a fake broker and the
      SDK's fake Gladys (virtual clock, plus a real-clock test).
- [ ] **Milestone 2 — real TeslaMate**: run against a real TeslaMate (or
      recorded `mosquitto_sub -v` dumps from testers); check the units of
      `charger_power` (kW expected) and of `power` (documented as W, the Tesla
      API gives kW: left out until checked), which topics a car really
      publishes empty, the `since` order in the retained burst.
- [ ] **Milestone 3 — more**: miles / °F option (TeslaMate publishes km and
      °C), `time_to_full_charge`, `update_available` / `version`, sunroof,
      per-window and per-door states, a distance from home (needs the
      `location` permission).
- [ ] **Milestone 4 — first release**: Release workflow, topic, GHCR public.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- TeslaMate is AGPL-3.0: nothing of it is copied or ported; only the topics
  and meanings of its public MQTT documentation are used
  (THIRD_PARTY_NOTICES.md). Read only in v1 (brief of lot 21).
- Identity: `car:<namespace|default>-<car_id>`; the namespace "default" is
  refused (it would share the ids of an installation without namespace).
  The VIN is never in an id (personal data); a salted fingerprint in memory
  only flags one car under two ids (`TESLAMATE_SAME_CAR_AS`).
- Freshness: a retained value is never sent as new. Equal to Gladys: nothing;
  different: dated 1 ms after the last change Gladys knows of (the earliest
  it can be from); a feature without value: dated at `since` of the car.
  Without a date: nothing until a live value. Dated states start no scene.
- Empty payload = "no value" (TeslaMate docs): unknown, never 0. Odometer
  never decreasing (a lower value ignored, the highest known from Gladys).
- Not read: VIN (but the fingerprint), active_route, speed, heading,
  elevation, shift state, deprecated latitude/longitude, `power` (unit
  uncertain).
- Position off by default, rounded to 3 decimals before anything keeps it;
  geofence on by default (a name the user drew). Turning off erases the
  value shown ('' text).
- State as TeslaMate's English word (text): scenes independent of the
  language option.
- Charging states mapped like gladys-tesla (Disconnected -> IDLE).
- Units only from DEVICE_FEATURE_UNITS_BY_CATEGORY: charging power in kW
  (the EV charge category has no W).
- 250 states per minute, measurements 10 s apart per feature; at most 20
  cars; packets 64 KB, values 4 KB.
- Manifest: `gladys_version >=5.1.0`, category `vehicles`; no keywords nor
  countries (worldwide, the store derives them).

## Forum

No dedicated topic: the recap message of the general thread (/t/10385) at
the first release.
