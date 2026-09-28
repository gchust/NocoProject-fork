/**
 * NocoProject 协议类型：邮箱邀请（NP-88，docs/phase2/invitations.md）。
 *
 * 只有浏览器与服务端使用，CLI 不复制。
 */

/** 邀请状态；`expired` 由 `expiresAt` 推出，不存库 */
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

/** `GET /np/invitations` 的一行（待接受与已过期） */
export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly status: InvitationStatus;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly invitedBy: { readonly userId: string; readonly name: string };
  readonly expiresAt: string;
  /** 最近一次发信成功的时间；null 表示发信失败 */
  readonly sentAt: string | null;
  readonly createdAt: string;
}

/** `POST /np/invitations`：一次多个邮箱，加入的项目可多选（按 member 加入） */
export interface CreateInvitationsRequest {
  readonly emails: readonly string[];
  readonly projectIds?: readonly string[];
}

/**
 * 每个邮箱的结果：
 * - `invited`：已发邀请（同一邮箱已有待接受的邀请时，合并项目并重新发送）；
 * - `added`：邮箱已有账号，直接加入所选项目；
 * - `alreadyMember`：已有账号，且没有要新加入的项目。
 */
export type InvitationOutcome = 'invited' | 'added' | 'alreadyMember';

export interface InvitationResult {
  readonly email: string;
  readonly outcome: InvitationOutcome;
  /** `invited` 时：邮件是否已发出 */
  readonly emailSent?: boolean;
  /** 发信失败时返回一次邀请链接，供邀请人手动转发；链接不再能从列表取回 */
  readonly inviteUrl?: string;
}

export interface CreateInvitationsResponse {
  readonly results: readonly InvitationResult[];
}

/** `POST /np/public/invitations/lookup`（公开，body `{ token }`）：接受页展示的内容 */
export interface PublicInvitation {
  readonly email: string;
  readonly inviterName: string;
  readonly projectNames: readonly string[];
  readonly expiresAt: string;
}

/** `POST /np/public/invitations/accept`（公开）：建账号并加入项目；token 放在 body 里，不进请求日志 */
export interface AcceptInvitationRequest {
  readonly token?: string;
  readonly name: string;
  readonly password: string;
}

export interface AcceptInvitationResponse {
  readonly email: string;
  /** 接受前该邮箱已有账号：只加入项目，用原密码登录 */
  readonly existingAccount: boolean;
}
