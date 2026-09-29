import type { AppClientRegisteredRoute } from '@nocobase/app-client/plugins';
import { API_KEYS_ROUTE_ID } from '@nocobase/app-plugin-api-keys/client/routes';

/**
 * Whether the settings gear should appear (NP-153): every member is granted `page:api-keys` so `/profile` can link to
 * the transitional `/settings/api-keys` page, so that grant alone must not make the gear appear for everyone. It
 * appears only when at least one other platform settings page is open to the viewer.
 */
export function hasVisiblePlatformSettings(
  pages: readonly AppClientRegisteredRoute[],
): boolean {
  return pages.some(
    (page) => `${page.packageName}:${page.id}` !== API_KEYS_ROUTE_ID,
  );
}
