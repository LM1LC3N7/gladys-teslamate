# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Teslas read from TeslaMate over the local MQTT broker of the user (read
  only): battery levels, rated and estimated range, charging state, power,
  current and voltage, energy added, charge limit, plugged in, inside and
  outside temperatures, climate, odometer (never decreasing), locks, Sentry
  mode, doors, trunks, windows, tyre pressures and the state of each car.
- The TeslaMate geofence (on by default) and the position rounded to about
  100 m (off by default); turning either off erases the value shown.
- `MQTT_NAMESPACE` support; at most 20 cars; one car under two ids flagged
  (salted VIN fingerprint in memory, the VIN never shown nor kept).
- Values kept by the broker never sent as new: dated, or not sent.
- Refused credentials: a stop persisted in `/data`, next tries 15 min, 1 h,
  6 h, then every 24 h; messages bounded before they are read (MQTT 5
  `maximumPacketSize` and a guard on the socket); MQTT 3.1.1 fallback.
- "Test the connection" button naming the cars TeslaMate publishes.
- User guides in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-teslamate/commits/main
