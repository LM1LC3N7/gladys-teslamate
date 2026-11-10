// A fake mqtt.js client: what the app subscribed to, and the broker side
// (connect, deliver a message, refuse, fail). The app never publishes: any
// publish is recorded so a test can prove it.

import { EventEmitter } from 'node:events';

export class FakeMqttClient extends EventEmitter {
  constructor(config, options) {
    super();
    this.config = config;
    this.options = options;
    this.connected = false;
    this.subscriptions = [];
    this.published = [];
    this.ended = false;
  }

  subscribe(topics, options, callback) {
    this.subscriptions.push(...[].concat(topics));
    callback?.(null, []);
  }

  publish(topic, payload) {
    this.published.push({ topic, payload: String(payload) });
  }

  end() {
    this.ended = true;
    this.connected = false;
  }

  // --- The broker side ---
  open() {
    this.connected = true;
    this.emit('packetreceive', { cmd: 'connack' });
    this.emit('connect');
  }

  close() {
    this.connected = false;
    this.emit('close');
  }

  refuse(code = 5) {
    const err = new Error('Connection refused: Not authorized');
    err.code = code;
    this.emit('error', err);
    this.emit('close');
  }

  deliver(topic, payload, { retain = false } = {}) {
    this.emit('message', topic, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)), {
      retain,
    });
  }
}

/** A connect function for the app, keeping every client it creates. */
export function fakeConnector() {
  const clients = [];
  return {
    clients,
    get last() {
      return clients.at(-1);
    },
    connect: (config, options) => {
      const client = new FakeMqttClient(config, options);
      clients.push(client);
      return client;
    },
  };
}
