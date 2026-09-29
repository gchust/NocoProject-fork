/**
 * Computer credentials (NP-150), server- and browser-only (the CLI's sync-protocol drops this file; the daemon only
 * needs `COMPUTER_KEY_HEADER` from `protocol.daemon-compat.ts`). A computer credential is issued when a computer is
 * added, authenticates only `/np/daemon/*`, is bound to the daemon id the computer first registers with, and is
 * revoked on its own. The secret is returned once, by `POST /np/computers`.
 */

export interface NpComputer {
  readonly id: string;
  readonly ownerUserId: string;
  readonly ownerName: string | null;
  readonly name: string;
  /** The first characters of the credential, to recognise it. */
  readonly keyStart: string | null;
  /** The daemon the credential is bound to (set at its first register). */
  readonly daemonId: string | null;
  /** The device name that daemon reported. */
  readonly deviceName: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  /** Whether the viewer may revoke it (its owner, or owner/admin). */
  readonly canRevoke: boolean;
}

/** `POST /np/computers` */
export interface CreateComputerRequest {
  readonly name: string;
}

export interface CreateComputerResponse {
  readonly computer: NpComputer;
  /** Shown once: `nocoproject login --server <url> --computer-key-stdin`. */
  readonly key: string;
}
