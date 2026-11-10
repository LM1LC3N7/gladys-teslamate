// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in teslamate-state.json, readable by the container user only (0600):
//   - `auth`: `{ failures, until }` after the broker refused the
//     credentials: no connection before `until`, the next tries spaced
//     (15 min, 1 h, 6 h, then every 24 h), never in a loop, even across a
//     restart.
// Never a secret: no user name, no password, not even a hash of them. Read
// back bounded (a clock moved or a file edited by hand never gives a stop
// longer than its maximum), only known keys of the expected shape (never an
// inherited or `__proto__` key).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/teslamate-state.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 4096 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const lastRetry = TIMINGS.authRetry.at(-1);

/** The persisted state, repaired and bounded against `now`. */
export function normalizeMemory(raw, now) {
  const auth = own(raw, 'auth');
  const failures = own(auth, 'failures');
  const until = own(auth, 'until');
  return {
    auth: {
      failures: Number.isInteger(failures) && failures > 0 ? Math.min(failures, 1000) : 0,
      until: Number.isFinite(until) && until > now ? Math.min(until, now + lastRetry) : 0,
    },
  };
}

export const serializeMemory = ({ auth }) => ({
  auth: { failures: auth.failures, until: auth.until },
});

/** The wait after the n-th refusal in a row (1-based). */
export const authWait = (failures) =>
  TIMINGS.authRetry[Math.min(Math.max(failures, 1), TIMINGS.authRetry.length) - 1];
