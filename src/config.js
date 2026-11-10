// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password of
// the broker is kept here and in the MQTT client only: never logged, never in
// /data, never in a status or an error.
// -----------------------------------------------------------------------------

import { DEFAULT_NAMESPACE_ID, LIMITS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  broker_url: '',
  username: '',
  password: '',
  verify_certificate: true,
  namespace: '',
  publish_geofence: true,
  publish_position: false,
  language: 'fr',
};

/** TCP or TLS only (the size guard of src/mqtt.js reads the raw MQTT stream). */
const SCHEMES = { 'mqtt:': false, 'tcp:': false, 'mqtts:': true, 'ssl:': true };

/** Only `true` (or the text "true") turns on. */
const strictTrue = (value) => value === true || value === 'true';
/** Only `false` (or the text "false") turns off: a missing value keeps the default. */
const strictFalse = (value) => value === false || value === 'false';

/** No control character (CR, LF, NUL...) anywhere in a user name or a password. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The broker URL, completed: "192.168.1.10" -> "mqtt://192.168.1.10".
 * @returns {{ url: string, host: string, port: number, tls: boolean } | { error: string }}
 */
export function parseBrokerUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { error: 'empty' };
  }
  if (text.length > 300 || CONTROL.test(text)) {
    return { error: 'invalid' };
  }
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `mqtt://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (!Object.hasOwn(SCHEMES, url.protocol) || !url.hostname) {
    return { error: 'invalid' };
  }
  if (url.username || url.password) {
    // Credentials belong to their own fields (the secret one is never shown again).
    return { error: 'credentials' };
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { error: 'invalid' };
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '0.0.0.0' || host === '::' || /^(22[4-9]|23\d|255)\./.test(host)) {
    // Neither "any address", nor multicast, nor broadcast: a broker has an address.
    return { error: 'invalid' };
  }
  const secure = SCHEMES[url.protocol];
  return {
    /** scheme://host[:port]: nothing else, so it may be logged. */
    url: `${secure ? 'mqtts' : 'mqtt'}://${url.host}`,
    host,
    port: url.port ? Number(url.port) : secure ? 8883 : 1883,
    tls: secure,
  };
}

/**
 * The MQTT_NAMESPACE of TeslaMate: empty (none) or one topic level of
 * letters, digits, `_` and `-` (never `/`, `+`, `#`, a dot or a control
 * character: it goes into a topic filter and into the device ids).
 * @returns {{ namespace: string | undefined } | { error: string }}
 */
export function parseNamespace(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { namespace: undefined };
  }
  if (text.length > LIMITS.namespace || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return { error: 'namespace' };
  }
  if (text === DEFAULT_NAMESPACE_ID) {
    // Would share its ids with an installation without namespace.
    return { error: 'namespace' };
  }
  return { namespace: text };
}

export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const broker = parseBrokerUrl(c.broker_url);
  const ns = parseNamespace(c.namespace);
  const username = typeof c.username === 'string' ? c.username.trim() : '';
  const password = typeof c.password === 'string' ? c.password : '';
  let problem = broker.error ?? ns.error;
  if (!problem && (CONTROL.test(username) || CONTROL.test(password))) {
    problem = 'control';
  }
  if (!problem && password !== '' && username === '') {
    // Mosquitto (and MQTT 3.1.1) never take a password without a user name.
    problem = 'password_without_user';
  }
  return {
    problem,
    brokerUrl: broker.url,
    host: broker.host,
    port: broker.port,
    tls: broker.tls ?? false,
    username,
    password,
    verifyCertificate: !strictFalse(c.verify_certificate),
    namespace: ns.namespace,
    publishGeofence: !strictFalse(c.publish_geofence),
    publishPosition: strictTrue(c.publish_position),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** The topic prefix TeslaMate publishes under: teslamate[/<namespace>]/cars/. */
export const topicPrefix = (config) =>
  config.namespace ? `teslamate/${config.namespace}/cars/` : 'teslamate/cars/';

/** What a reconnection to the broker depends on (compared in memory only, never stored). */
export const connectionKey = (config) =>
  JSON.stringify([
    config.problem ?? null,
    config.brokerUrl ?? null,
    config.username,
    config.password,
    config.verifyCertificate,
    config.namespace ?? null,
  ]);

/** The credentials only: other credentials lift the stop on refused ones. */
export const credentialsKey = (config) =>
  JSON.stringify([config.brokerUrl ?? null, config.username, config.password]);
