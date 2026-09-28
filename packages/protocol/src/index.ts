/**
 * @nocoproject/protocol — placeholder. At the workspace cutover the protocol files move here from
 * nocoproject/server/modules/shared/protocol*.ts (see nocosolution/NocoProject/docs/phase1/workspace.md).
 * Development resolves this TypeScript source directly (`exports`); `pnpm build` emits `dist/`, which
 * `nocobase build` vendors into the server deployment (`publishConfig.exports`).
 */
export type ProtocolPackageMarker = 'nocoproject-protocol';
export const PROTOCOL_PACKAGE_MARKER: ProtocolPackageMarker = 'nocoproject-protocol';
