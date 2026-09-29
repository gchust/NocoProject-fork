import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';

/** The keys of a message box that submits on Enter: Enter sends, Shift + Enter starts a new line. */
export function NpSubmitHint({
  className,
}: {
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'items-center gap-1 text-xs text-muted-foreground',
        className,
      )}
    >
      <Kbd>Enter</Kbd>
      {t('np.composer.quickSend')}
      <Kbd className='ml-2'>Shift</Kbd>
      <Kbd>Enter</Kbd>
      {t('np.composer.newLine')}
    </span>
  );
}
