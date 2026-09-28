import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';

/** "New issue" from a page other than `/issues`: opens the create dialog over the issue list. */
export function NewIssueButtonAbsolute({
  variant = 'default',
}: {
  readonly variant?: 'default' | 'outline';
}): ReactElement {
  const { t } = useTranslation();
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
