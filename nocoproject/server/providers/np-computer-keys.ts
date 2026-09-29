/**
 * NP-150: computer credentials are API keys of the non-session `np-computer` configuration
 * (`server/config/auth.ts`), created, verified and disabled through the API Keys plugin's trusted `ApiKeyService`,
 * never by writing the `apikey` table. Creation and disabling run on the caller's transaction.
 */
import { authenticationToken } from '@nocobase/app-plugin-authentication';
import { ApiKeyService } from '@nocobase/app-plugin-api-keys/server';
import type { Application } from '@nocobase/app-server/application';

import { COMPUTER_KEY_CONFIG_ID } from '../auth/np-api-key-guard.js';
import type { ComputerKeys } from '../modules/computer/computer.service.js';

export function createPluginComputerKeys(app: Application): ComputerKeys {
  const service = () =>
    new ApiKeyService(
      app.container.resolve(authenticationToken),
      COMPUTER_KEY_CONFIG_ID,
    );
  return {
    async create(conn, input) {
      const { key, secret } = await service()
        .withConnection(conn)
        .create({ userId: input.userId, name: input.name });
      return { keyId: key.id, keyStart: key.start ?? null, secret };
    },
    async verify(secret) {
      const key = await service().verify(secret);
      return key && key.enabled !== false
        ? { keyId: key.id, userId: key.referenceId }
        : null;
    },
    async disable(conn, keyId) {
      await service().withConnection(conn).disable(keyId);
    },
  };
}
