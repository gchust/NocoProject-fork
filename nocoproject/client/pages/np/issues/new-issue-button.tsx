import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

/**
 * The issues page's one "新建任务" button (iteration 4 §D): the `new` dialog creates one issue or many (AI 整理 /
 * 手动). It is a child route of `/issues` and keeps the list's query string, so a filtered project is preselected.
 */
export function NewIssueButton({
  variant = 'default',
}: {
  readonly variant?: 'default' | 'outline';
}): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
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
