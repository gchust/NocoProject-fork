/**
 * Browser-side types for email invitations (NP-88), copied from `server/modules/shared/protocol.invitations-server.ts`
 * (the client tsconfig includes only `client/`). Keep them in step with that file.
 */

export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly status: InvitationStatus;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly invitedBy: { readonly userId: string; readonly name: string };
  readonly expiresAt: string;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export type InvitationOutcome = 'invited' | 'added' | 'alreadyMember';

export interface InvitationResult {
  readonly email: string;
  readonly outcome: InvitationOutcome;
  readonly emailSent?: boolean;
  readonly inviteUrl?: string;
}

export interface PublicInvitation {
  readonly email: string;
  readonly inviterName: string;
  readonly projectNames: readonly string[];
  readonly expiresAt: string;
}

export interface AcceptInvitationResponse {
  readonly email: string;
  readonly existingAccount: boolean;
}
