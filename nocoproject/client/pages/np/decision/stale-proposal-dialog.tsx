import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

import type { DecisionRunner } from './use-decision.js';

/**
 * "This proposal is based on an older version": shown when accepting a knowledge proposal from a decision card finds
 * the document moved on since the agent proposed (NP-152). Confirming accepts it anyway, like the knowledge page.
 */
export function StaleProposalDialog({
  runner,
}: {
  readonly runner: DecisionRunner;
}): ReactElement {
  const { t } = useTranslation();
  const { stale } = runner;
  return (
    <AlertDialog
      open={stale !== null}
      onOpenChange={(open) => {
        if (!open) runner.dismissStale();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('np.knowledge.proposals.staleTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('np.knowledge.proposals.staleDescription', {
              base: stale?.baseVersion ?? '?',
              current: stale?.currentVersion,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={runner.acceptStale}>
            {t('np.knowledge.proposals.acceptAnyway')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
