import { useTranslation } from '@nocobase/i18n/client';

import type { InboxDecisionAction } from '../types-iter3.js';

/**
 * The label of an action. A decision type may word an action its own way (`np.decision.actions.<type>.<key>`, so
 * accepting a delivery reads "验收通过" while accepting a knowledge proposal reads "接受"); otherwise the server's
 * i18n key, else ours for its `key`, else the key itself.
 */
export function useActionLabel(): (
  action: InboxDecisionAction,
  type?: string,
) => string {
  const { t } = useTranslation();
  return (action, type) => {
    const generic = t(action.label, {
      defaultValue: t(`np.inboxActions.${action.key}`, {
        defaultValue: action.key,
      }),
    });
    return type
      ? t(`np.decision.actions.${type}.${action.key}`, {
          defaultValue: generic,
        })
      : generic;
  };
}
