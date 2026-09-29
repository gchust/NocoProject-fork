import type { AppConfigFactory } from '@nocobase/app-server/config';
import { apiKey } from '@nocobase/app-plugin-api-keys/server';
import {
  defineAuthConfig,
  type AuthConfig,
} from '@nocobase/app-plugin-authentication/server';
import { username } from 'better-auth/plugins';

import {
  COMPUTER_KEY_CONFIG_ID,
  npApiKeyGuard,
} from '../auth/np-api-key-guard.js';

const auth: AppConfigFactory<AuthConfig> = defineAuthConfig({
  defaults: {
    // NP-150: personal keys keep the default configuration (and their stored `configId`); computer credentials are
    // the non-session `np-computer` configuration, verified only by the daemon guard. The guard's hooks run first.
    plugins: [
      username({ displayUsername: false }),
      npApiKeyGuard(),
      apiKey([
        { configId: 'default' },
        {
          configId: COMPUTER_KEY_CONFIG_ID,
          enableSessionForAPIKeys: false,
          defaultPrefix: 'npc_',
        },
      ]),
    ],
    emailAndPassword: { enabled: true, autoSignIn: false },
    session: { storeSessionInDatabase: true },
  },
});

export default auth;
