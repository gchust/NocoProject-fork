/**
 * Secret encryption for values NocoProject must store and later use in clear (docs/phase1/iteration-2-contract.md
 * §B): the GitHub token and webhook secret, agent environment variables.
 *
 * AES-256-GCM, ciphertext `v1:<iv b64>:<tag b64>:<data b64>`. The key comes from `NOCOPROJECT_SECRET_KEY` (32 bytes
 * as 64 hex characters or base64; configuration section `nocoproject.secretKey`). Without it the key is derived as
 * `sha256(auth.secret + ':nocoproject')` and a warning is logged once: fine for development, but production must
 * configure the key explicitly so rotating the auth secret does not make every stored secret unreadable.
 *
 * The key is resolved only here; services receive a `SecretBox` and call `encrypt` / `decrypt`. Nothing in this file
 * logs a key, a plaintext or a ciphertext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface SecretBox {
  encrypt(plaintext: string): string;
  /** Throws when the ciphertext is malformed or was sealed with another key. */
  decrypt(ciphertext: string): string;
}

export interface SecretKeySource {
  /** `NOCOPROJECT_SECRET_KEY`: 64 hex characters or base64 of 32 bytes. */
  readonly secretKey?: string | null;
  /** `auth.secret`, used to derive a development key when `secretKey` is absent. */
  readonly authSecret?: string | null;
}

export class SecretKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === KEY_BYTES) return decoded;
  throw new SecretKeyError(
    'NOCOPROJECT_SECRET_KEY must be 32 bytes, as 64 hex characters or base64.',
  );
}

/**
 * The 32-byte key. `warn` is called (once per call of this function) when the key is derived from the auth secret;
 * with neither source a random process-local key is used, which only tests should ever reach.
 */
export function resolveSecretKey(
  source: SecretKeySource,
  warn: (message: string) => void = () => undefined,
): Buffer {
  if (source.secretKey && source.secretKey.trim())
    return decodeKey(source.secretKey);
  if (source.authSecret) {
    warn(
      'NOCOPROJECT_SECRET_KEY is not set; NocoProject secrets are encrypted with a key derived from auth.secret. ' +
        'Set NOCOPROJECT_SECRET_KEY in production.',
    );
    return createHash('sha256')
      .update(`${source.authSecret}:nocoproject`)
      .digest();
  }
  warn(
    'Neither NOCOPROJECT_SECRET_KEY nor auth.secret is available; NocoProject secrets use a random key that does ' +
      'not survive a restart.',
  );
  return randomBytes(KEY_BYTES);
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES)
    throw new SecretKeyError('The NocoProject secret key must be 32 bytes.');
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const data = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString('base64'),
        tag.toString('base64'),
        data.toString('base64'),
      ].join(':');
    },
    decrypt(ciphertext) {
      const parts = ciphertext.split(':');
      if (parts.length !== 4 || parts[0] !== VERSION)
        throw new SecretKeyError('Unsupported ciphertext format.');
      const [, iv, tag, data] = parts as [string, string, string, string];
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
