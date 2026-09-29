import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

/**
 * The issues page's one "New issue" button (iteration 4 §D): the `new` dialog creates one issue or many (AI draft /
 * Manual). It is a child route of `/issues` and keeps the list's query string, so a filtered project is preselected.
 * Without `issues/edit` (NP-161, `canEdit`) it does not render, since creating an issue would only 403; the caller
 * computes it from the viewer's scope, since this component has no data fetching of its own.
 */
export function NewIssueButton({
  variant = 'default',
  canEdit = true,
}: {
  readonly variant?: 'default' | 'outline';
  readonly canEdit?: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const location = useLocation();
  if (!canEdit) return null;
  return (
    <Button
      variant={variant}
      nativeButton={false}
      render={<Link to={{ pathname: 'new', search: location.search }} />}
    >
      <PlusIcon data-icon='inline-start' />
      {t('np.issues.new')}
      {variant === 'default' ? (
        <Kbd data-icon='inline-end' aria-hidden='true'>
          C
        </Kbd>
      ) : null}
    </Button>
  );
}
