/**
 * The invitation email (NP-88): what is sent, and the port the service sends it through. The provider backs the port
 * with the notification plugin's SMTP channel (`server/providers/np-mail.ts`); tests pass a recording double.
 */

export interface InvitationEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Stable per invitation token, so a retried request never sends the same link twice. */
  readonly idempotencyKey: string;
}

export interface InvitationMailer {
  /** Submits the email for delivery; throws when no email channel is configured or the submission is refused. */
  send(email: InvitationEmail): Promise<void>;
}

/** The mailer used when nothing is configured: every send fails, so the inviter gets the link to forward. */
export const unconfiguredMailer: InvitationMailer = {
  send: async () => {
    throw new Error('No invitation email channel is configured.');
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function buildInvitationEmail(input: {
  readonly to: string;
  readonly inviterName: string;
  readonly projectNames: readonly string[];
  readonly url: string;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
}): InvitationEmail {
  const expires = input.expiresAt.toISOString().slice(0, 10);
  const projects = input.projectNames.length
    ? `，并加入项目：${input.projectNames.join('、')}`
    : '';
  const subject = `${input.inviterName} 邀请你加入 NocoProject`;
  const text = [
    `${input.inviterName} 邀请你加入 NocoProject${projects}。`,
    '',
    `打开下面的链接设置姓名和密码即可加入（${expires} 前有效，只能使用一次）：`,
    input.url,
    '',
    `${input.inviterName} invited you to NocoProject. Open the link above to set your name and password (valid until ${expires}).`,
  ].join('\n');
  const html = [
    `<p>${escapeHtml(input.inviterName)} 邀请你加入 NocoProject${escapeHtml(projects)}。</p>`,
    `<p><a href="${escapeHtml(input.url)}">接受邀请</a>（${expires} 前有效，只能使用一次）</p>`,
    `<p>如果按钮无法打开，复制这个链接到浏览器：<br>${escapeHtml(input.url)}</p>`,
    `<p style="color:#888">${escapeHtml(input.inviterName)} invited you to NocoProject. Open the link to set your name and password (valid until ${expires}).</p>`,
  ].join('\n');
  return {
    to: input.to,
    subject,
    text,
    html,
    idempotencyKey: input.idempotencyKey,
  };
}
