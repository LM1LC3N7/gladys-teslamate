# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## TeslaMate (not included)

<https://github.com/teslamate-org/teslamate>, the self-hosted Tesla data
logger, is licensed under the GNU Affero General Public License v3 (AGPL-3.0,
`LICENSE` of its repository, read on 2026-11-10 at commit 965c2aa, release
v4.4.0). **No part of TeslaMate is included, copied or ported here.** This
integration only reads, as any MQTT client does, the messages a running
TeslaMate publishes on the broker of the user, as described by its public
documentation (<https://docs.teslamate.org/docs/integrations/mqtt>: the topic
names and the meaning of their values). The code reading them was written
from that description only.

## Runtime dependencies (npm)

Installed by `npm ci` into the image, not modified, each under its own
licence file in `node_modules`:

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys SDK;
- `mqtt` (mqtt.js, MIT, <https://github.com/mqttjs/MQTT.js>), the MQTT client,
  and its dependencies (MIT, ISC, BSD and Apache-2.0 licences, listed by
  `npm ls --omit=dev --all`).

## Gladys-testkit (tests only)

`test/helpers/clock.js` is a copy of `src/clock.mjs` of gladys-testkit
(Apache-2.0, the same author as this integration). It is not part of the image.
