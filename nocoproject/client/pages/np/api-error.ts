import { ApiClientError } from '@nocobase/app-client';

/** Server error codes with a translated reason, so a rejected save says why instead of "request failed". */
const CODE_KEYS: Readonly<Record<string, string>> = {
  PM_AGENT_NOT_ELIGIBLE: 'np.entries.errors.notManager',
  MANAGER_NOT_COMPLETION: 'np.entries.errors.managerCompletion',
  INVALID_ENTRY_AGENT: 'np.entries.errors.invalidAgent',
};

/**
 * The text for a failed write: forbidden, a translated reason for a known `code`, the server's own `message` for
 * any other 4xx, and "request failed" only when there is nothing better (network errors, 5xx).
 */
export function apiErrorMessage(
  t: (key: string) => string,
  error: unknown,
): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return t('np.common.forbidden');
    const key = error.code ? CODE_KEYS[error.code] : undefined;
    if (key) return t(key);
    const status = error.status ?? 0;
    if (status >= 400 && status < 500 && error.message.trim())
      return error.message;
  }
  return t('np.common.requestFailed');
}
