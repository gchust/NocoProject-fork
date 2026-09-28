/**
 * NP-88: the two plugin-backed ports of the invitation service.
 *
 * - Mail goes through the notification plugin (`notificationServiceToken`) on the `np-email` SMTP channel
 *   (`server/config/notification.ts`). A disabled or missing channel, or a delivery the plugin reports as failed,
 *   is an error, so the inviter gets the link to forward instead.
 * - Accounts are created by the authentication plugin's user administration service on the invitation's own
 *   transaction, so a failure later in acceptance leaves no account behind.
 */
import {
  UserAdministrationError,
  userAdministrationServiceToken,
} from '@nocobase/app-plugin-authentication';
import {
  notificationServiceToken,
  type NotificationConfig,
} from '@nocobase/app-plugin-notification/server';
import type { Application } from '@nocobase/app-server/application';

import { NP_EMAIL_CHANNEL } from '../config/notification.js';
import type { InvitationAccounts } from '../modules/member/invitation.service.js';
import {
  unconfiguredMailer,
  type InvitationMailer,
} from '../modules/member/invitation.mail.js';
import { conflict, invalid } from '../modules/shared/errors.js';

export function createNotificationMailer(app: Application): InvitationMailer {
  const channel =
    app.config.get<NotificationConfig>('notification')?.channels?.[
      NP_EMAIL_CHANNEL
    ];
  if (
    !channel ||
    channel.enabled === false ||
    !app.container.has(notificationServiceToken)
  )
    return unconfiguredMailer;
  return {
    async send(email) {
      const result = await app.container
        .resolve(notificationServiceToken)
        .send({
          idempotencyKey: email.idempotencyKey,
          source: { type: 'np-invitation' },
          messages: {
            [NP_EMAIL_CHANNEL]: {
              to: email.to,
              subject: email.subject,
              text: email.text,
              html: email.html,
            },
          },
        });
      const failed = result.deliveries.find(
        (delivery) => delivery.status === 'failed',
      );
      if (failed)
        throw new Error(
          failed.error?.message ?? 'The email was not delivered.',
        );
    },
  };
}

export function createPluginAccounts(
  app: Application,
): InvitationAccounts | null {
  if (!app.container.has(userAdministrationServiceToken)) return null;
  return {
    async create(conn, input) {
      try {
        const user = await app.container
          .resolve(userAdministrationServiceToken)
          .withConnection(conn)
          .create(input);
        return user.id;
      } catch (error) {
        if (!(error instanceof UserAdministrationError)) throw error;
        if (
          error.code === 'PASSWORD_TOO_SHORT' ||
          error.code === 'PASSWORD_TOO_LONG'
        )
          throw invalid('INVALID_PASSWORD', error.message);
        throw conflict('ACCOUNT_CONFLICT', error.message);
      }
    },
  };
}
