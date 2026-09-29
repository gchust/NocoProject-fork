import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';

/**
 * "New issue" from a page other than `/issues`: opens the create dialog over the issue list. Without `issues/edit`
 * (NP-161, `canEdit`) it does not render, since creating an issue would only 403; the caller computes it from the
 * viewer's scope, since this component has no data fetching of its own.
 */
export function NewIssueButtonAbsolute({
  variant = 'default',
  canEdit = true,
}: {
  readonly variant?: 'default' | 'outline';
  readonly canEdit?: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!canEdit) return null;
  return (
    <Button
      variant={variant}
      nativeButton={false}
      render={<Link to='/issues/new' />}
    >
      <PlusIcon data-icon='inline-start' />
      {t('np.issues.new')}
    </Button>
  );
}
