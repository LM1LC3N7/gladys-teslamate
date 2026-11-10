# gladys-teslamate

[Gladys Assistant](https://gladysassistant.com) external integration for
**TeslaMate**, the self-hosted Tesla data logger, over the **local MQTT
broker of the user** TeslaMate publishes to: battery, range, charge, doors,
trunks, windows, locks, Sentry mode, temperatures, tyre pressures, odometer
and state of each car, the TeslaMate geofence and, when allowed, the position
rounded to about 100 m. **Read only. Never tested with a real car.
Unofficial, not affiliated with Tesla nor with TeslaMate.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (TeslaMateApp)
                                  ├─ src/mqtt.js       mqtt.js client over a guarded socket (packets bounded)
                                  ├─ src/car.js        TeslaMate topics -> features, strict parsers (pure)
                                  ├─ src/store.js      /data: the stop on refused credentials (no secret)
                                  └─ src/publisher.js  states within 250/min, measurements 10 s apart
```

- **Reads**: subscribes to `teslamate[/<namespace>]/cars/+/+` only, never
  publishes. The topics documented by TeslaMate
  ([MQTT Integration](https://docs.teslamate.org/docs/integrations/mqtt)) are
  read strictly (numbers, booleans, bounded texts); empty means unknown.
- **Devices**: `ext:<selector>:car:<namespace|default>-<car_id>`; features
  `<device>:<key>` (keys in `src/car.js`, frozen); only the features seen; a
  created device never loses a feature.
- **Freshness**: live values sent now; retained values dated (never as new)
  or not sent; nothing sent again on a reconnection to Gladys.
- **Privacy**: no VIN (salted fingerprint in memory only), no navigation, the
  position off by default and rounded to 3 decimals.
- **Failures**: refused credentials stop the client, a stop persisted in
  `/data`, next tries 15 min, 1 h, 6 h, 24 h; an unreachable broker is tried
  every 10 s; the configuration unreadable from Gladys is read again, spaced,
  without end.

Modelled on the sibling integrations
[gladys-qbus](https://github.com/LM1LC3N7/gladys-qbus) (local MQTT, guarded
socket) and, for the mapping of the charging states, guim31's
[gladys-tesla](https://github.com/guim31/gladys-tesla) (Teslemetry).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
node scripts/cover.mjs cover.png                # cover.png, plain Node
memcap node scripts/mutants.mjs                 # mutation check of the guards
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the broker is a fake mqtt.js client
(`test/helpers/fakeMqtt.js`), Gladys is the SDK's fake, the clock is virtual
(`test/helpers/clock.js`) except in `test/realclock.test.js`.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). TeslaMate (AGPL-3.0) is neither included nor ported:
only its documented MQTT messages are read. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the Docker
image).
