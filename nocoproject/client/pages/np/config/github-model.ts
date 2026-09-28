import type { GitConnectionInput, GitConnectionView } from '../types.js';

/** 32 random bytes as hex, for a new webhook secret. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The PUT body from the form: the base URL only when it changed, a secret only when typed or explicitly cleared
 * (an empty string clears it on the server; a missing field keeps it).
 */
export function gitConnectionChanges(
  current: GitConnectionView,
  draft: {
    readonly apiBaseUrl: string;
    readonly token: string;
    readonly webhookSecret: string;
    readonly clearToken: boolean;
    readonly clearSecret: boolean;
  },
): GitConnectionInput {
  return {
    ...(draft.apiBaseUrl.trim() &&
    draft.apiBaseUrl.trim() !== current.apiBaseUrl
      ? { apiBaseUrl: draft.apiBaseUrl.trim() }
      : {}),
    ...(draft.clearToken
      ? { token: '' }
      : draft.token
        ? { token: draft.token }
        : {}),
    ...(draft.clearSecret
      ? { webhookSecret: '' }
      : draft.webhookSecret
        ? { webhookSecret: draft.webhookSecret }
        : {}),
  };
}
