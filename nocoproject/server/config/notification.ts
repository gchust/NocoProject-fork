import {
  defineAppConfig,
  envBoolean,
  envInteger,
  envString,
  type AppConfigFactory,
} from '@nocobase/app-server/config';
import type { NotificationConfig } from '@nocobase/app-plugin-notification/server';

/**
 * NP-88: the `np-email` channel sends invitation emails over SMTP (Brevo, `smtp-relay.brevo.com:587` with STARTTLS,
 * by default). It stays disabled until `NOCOPROJECT_SMTP_ENABLED=true`, because the notification plugin refuses to
 * start with an enabled channel that is not fully configured. Set the Brevo SMTP login and SMTP key with
 * `NOCOPROJECT_SMTP_USER` / `NOCOPROJECT_SMTP_PASSWORD` and a sender verified in Brevo with `NOCOPROJECT_SMTP_FROM`
 * (`NocoProject <noreply@example.com>`). While it is disabled, inviting still works and returns the link to forward.
 */
export const NP_EMAIL_CHANNEL = 'np-email';

const notification: AppConfigFactory<NotificationConfig> = defineAppConfig({
  env: {
    NOCOPROJECT_SMTP_ENABLED: envBoolean(
      `channels.${NP_EMAIL_CHANNEL}.enabled`,
    ),
    NOCOPROJECT_SMTP_HOST: envString(`channels.${NP_EMAIL_CHANNEL}.host`),
    NOCOPROJECT_SMTP_PORT: envInteger(`channels.${NP_EMAIL_CHANNEL}.port`),
    NOCOPROJECT_SMTP_SECURE: envBoolean(`channels.${NP_EMAIL_CHANNEL}.secure`),
    NOCOPROJECT_SMTP_USER: envString(`channels.${NP_EMAIL_CHANNEL}.auth.user`),
    NOCOPROJECT_SMTP_PASSWORD: envString(
      `channels.${NP_EMAIL_CHANNEL}.auth.pass`,
    ),
    NOCOPROJECT_SMTP_FROM: envString(`channels.${NP_EMAIL_CHANNEL}.from`),
  },
  defaults: () => ({
    channels: {
      [NP_EMAIL_CHANNEL]: {
        provider: 'smtp',
        enabled: false,
        host: 'smtp-relay.brevo.com',
        port: 587,
        secure: false,
      },
    },
  }),
});

export default notification;
