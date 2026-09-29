/**
 * Browser-side types for computer credentials (NP-150), copied from `server/modules/shared/protocol.computers-server.ts`
 * (the client tsconfig includes only `client/`). Keep them in step with that file.
 */
export interface NpComputer {
  readonly id: string;
  readonly ownerUserId: string;
  readonly ownerName: string | null;
  readonly name: string;
  readonly keyStart: string | null;
  readonly daemonId: string | null;
  readonly deviceName: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly canRevoke: boolean;
}

export interface CreateComputerResponse {
  readonly computer: NpComputer;
  /** Shown once. */
  readonly key: string;
}
