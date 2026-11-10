// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. No version is
// pinned: only its shape and its agreement across files.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { FEATURE_KEYS, buildDevice } from '../src/car.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS } from '../src/constants.js';
import { FEATURE_NAMES } from '../src/i18n.js';

// The core's own sources, when a Gladys clone is at hand (not on GitHub CI).
const CORE = '/home/claude/code/Gladys/server';
const require = createRequire(import.meta.url);
const normalizeSupportedOptions = existsSync(`${CORE}/utils/normalizeSupportedOptions.js`)
  ? require(`${CORE}/utils/normalizeSupportedOptions.js`).normalizeSupportedOptions
  : undefined;
const coreConstants = existsSync(`${CORE}/utils/constants.js`)
  ? require(`${CORE}/utils/constants.js`)
  : undefined;

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const fields = manifest.config_schema.filter((f) => f.type !== 'section');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, the version agreeing everywhere and never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-teslamate');
  assert.equal(lock.name, pkg.name);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-teslamate:${manifest.version}`);
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-teslamate\//,
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['vehicles']);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.equal(manifest.location, undefined, 'never the house location');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300);
    assert.match(docs, /never tested with a real car|jamais testé avec une vraie voiture/i);
  }
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('nothing is ever said to be encrypted; the secret has no default and the right words', () => {
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'src/i18n.js',
  ]) {
    assert.doesNotMatch(read(file), /\bchiffr|\bencrypt|\bhach(age|é)/i, file);
  }
  const secrets = fields.filter((f) => f.type === 'secret');
  assert.deepEqual(
    secrets.map((f) => f.key),
    ['password'],
  );
  for (const secret of secrets) {
    assert.equal(secret.default, undefined);
    assert.match(secret.description.en, /kept by Gladys in its database, never shown again/);
    assert.match(secret.description.fr, /gardé par Gladys dans sa base, jamais réaffiché/);
  }
});

test('every text is in English and French; keys never start with gladys_', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(typeof text[lang] === 'string' && text[lang].trim(), `${path} needs ${lang}`);
    }
  }
  const [intro] = manifest.config_schema;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang}`);
  }
  assert.ok(intro.links.every((l) => l.url.startsWith('https://')));
  for (const f of manifest.config_schema) {
    assert.doesNotMatch(f.key, /^gladys_/);
  }
});

test('the configuration defaults are the code ones', () => {
  assert.deepEqual(fields.map((f) => f.key).sort(), Object.keys(DEFAULT_CONFIG).sort());
  for (const f of fields) {
    if (f.default !== undefined) {
      assert.deepEqual(f.default, DEFAULT_CONFIG[f.key], f.key);
    }
  }
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(byKey.publish_position.default, false, 'the position is off by default');
  assert.equal(byKey.broker_url.required, true);
  assert.deepEqual(
    byKey.language.options.map((o) => o.value),
    ['fr', 'en'],
  );
  for (const option of byKey.language.options) {
    assert.equal(typeof option.label.en, 'string');
  }
});

test('the actions are the ones the code handles; read only (no onSetValue)', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const a of manifest.actions) {
    assert.ok(a.timeout_seconds >= 5 && a.timeout_seconds <= 120);
  }
  assert.ok(!/onSetValue\(/.test(handlers));
  assert.ok(!/\.publish\(/.test(read('src/app.js')), 'never publishes on the broker');
});

test('the features: known categories, types and units of the core, read only, never a switch', () => {
  const gladys = createFakeGladys();
  const device = buildDevice(
    gladys,
    { carId: '1', features: new Set(FEATURE_KEYS), name: 'Car', model: '3' },
    'fr',
  );
  assert.equal(device.features.length, FEATURE_KEYS.length);
  for (const f of device.features) {
    assert.equal(f.read_only, true, f.external_id);
    assert.equal(f.supported_options, undefined);
    assert.notEqual(f.category, 'switch');
    if (coreConstants) {
      const {
        DEVICE_FEATURE_CATEGORIES: C,
        DEVICE_FEATURE_TYPES: T,
        DEVICE_FEATURE_UNITS_BY_CATEGORY: U,
      } = coreConstants;
      assert.ok(Object.values(C).includes(f.category), f.category);
      const group = Object.entries(C).find(([, v]) => v === f.category)[0];
      const types = Object.values(T[group] ?? {}).concat(Object.values(T.SENSOR));
      assert.ok(types.includes(f.type), `${f.category}/${f.type}`);
      if (f.unit) {
        assert.ok(U[f.category]?.includes(f.unit), `${f.category} in ${f.unit}`);
      }
    }
  }
  for (const lang of ['en', 'fr']) {
    assert.deepEqual(Object.keys(FEATURE_NAMES[lang]).sort(), [...FEATURE_KEYS].sort());
  }
});

test('the supported_options published follow the rules of the core (none in v1)', () => {
  const gladys = createFakeGladys();
  const device = buildDevice(gladys, { carId: '1', features: new Set(FEATURE_KEYS) }, 'en');
  const options = device.features.flatMap((f) => f.supported_options ?? []);
  for (const option of options) {
    assert.equal(typeof option.label, 'string');
    assert.ok(option.label.length > 0 && option.label === option.label.trim());
  }
  if (normalizeSupportedOptions) {
    assert.deepEqual(normalizeSupportedOptions(options, { allowStringValues: true }), options);
  }
});

test('the image ships the licence and the notices', () => {
  assert.match(read('Dockerfile'), /COPY LICENSE THIRD_PARTY_NOTICES\.md \.\//);
  assert.match(read('Dockerfile'), /COPY src \.\/src/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /mqtt\.js/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /AGPL/);
});
