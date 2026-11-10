// A minimal real MQTT broker over TCP, for the tests of the real transport
// (src/mqtt.js: guarded socket, MQTT 5 then 3.1.1). Written for the review r1
// of this integration and kept here. It speaks through mqtt-packet, the
// parser mqtt.js itself depends on.
//
// Modes: 'ok'; 'refuse' (CONNACK refusal with `refuseCode`); 'swallow' (no
// answer); 'closeAfterConnect' (closes right after the CONNECT); 'v3only'
// (answers a MQTT 5 CONNECT like a 3.1.1 broker: return code 1). `times`:
// the mode applies to the first `times` connections only, then 'ok'.

import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mqttPacket = require('mqtt-packet');

const match = (filter, topic) => {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === '#') return true;
    if (f[i] === '+') {
      if (t[i] === undefined) return false;
      continue;
    }
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
};

export function broker({ mode = 'ok', refuseCode = 5, times = Infinity, auth } = {}) {
  const b = { retained: new Map(), conns: new Set(), connects: 0, connectLog: [], subs: [] };
  const modeFor = (n) => (n <= times ? mode : 'ok');
  const server = net.createServer((sock) => {
    const c = { sock, version: 4, subs: [] };
    b.conns.add(c);
    sock.on('close', () => b.conns.delete(c));
    sock.on('error', () => {});
    const send = (p) => {
      if (!sock.destroyed) sock.write(mqttPacket.generate(p, { protocolVersion: c.version }));
    };
    c.send = send;
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    parser.on('error', () => sock.destroy());
    parser.on('packet', (p) => {
      if (p.cmd === 'connect') {
        b.connects += 1;
        const m = modeFor(b.connects);
        c.version = p.protocolVersion;
        parser.settings.protocolVersion = p.protocolVersion;
        b.connectLog.push({
          version: p.protocolVersion,
          maxPacket: p.properties?.maximumPacketSize,
        });
        if (m === 'swallow') return;
        if (m === 'closeAfterConnect') {
          sock.end();
          return;
        }
        if (m === 'v3only' && p.protocolVersion === 5) {
          sock.write(Buffer.from([0x20, 0x02, 0x00, 0x01]));
          sock.end();
          return;
        }
        const badAuth =
          auth && (p.username !== auth.username || String(p.password) !== auth.password);
        if (m === 'refuse' || badAuth) {
          if (c.version === 5) {
            send({ cmd: 'connack', reasonCode: refuseCode === 5 ? 135 : refuseCode });
          } else {
            send({ cmd: 'connack', returnCode: refuseCode > 5 ? 5 : refuseCode });
          }
          sock.end();
          return;
        }
        send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false });
      } else if (p.cmd === 'subscribe') {
        send({ cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map(() => 0) });
        for (const s of p.subscriptions) {
          c.subs.push(s.topic);
          b.subs.push(s.topic);
        }
        for (const [topic, payload] of b.retained) {
          if (c.subs.some((f) => match(f, topic))) b.deliver(c, topic, payload, true);
        }
      } else if (p.cmd === 'pingreq') {
        send({ cmd: 'pingresp' });
      } else if (p.cmd === 'disconnect') {
        sock.end();
      }
    });
    sock.on('data', (d) => parser.parse(d));
  });
  b.deliver = (c, topic, payload, retain) => {
    c.send({
      cmd: 'publish',
      topic,
      payload: Buffer.from(String(payload)),
      qos: 0,
      retain,
      dup: false,
    });
  };
  b.publish = (topic, payload, { retain = false } = {}) => {
    if (retain) b.retained.set(topic, payload);
    for (const c of b.conns)
      if (c.subs.some((f) => match(f, topic))) b.deliver(c, topic, payload, false);
  };
  b.listen = () =>
    new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        b.port = server.address().port;
        resolve(b);
      }),
    );
  b.close = () =>
    new Promise((resolve) => {
      for (const c of b.conns) c.sock.destroy();
      server.close(() => resolve());
    });
  return b;
}
