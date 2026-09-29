import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { ConnectComputerSteps } from '@/components/connect-computer-steps';
import { RouteDialog } from '@/components/route-dialog';
import { Button } from '@/components/ui/button';
import { useRouteOverlay } from '@/components/use-route-overlay';

/** Route `/runtimes/connect`: how to connect a computer. Instructions only; nothing is submitted. */
export default function ConnectRuntimePage(): ReactElement {
  const { t } = useTranslation();
  return (
    <RouteDialog
      title={t('np.connect.title')}
      description={t('np.connect.description')}
      className='sm:max-w-2xl'
      footer={<ConnectFooter />}
    >
      <ConnectComputerSteps />
    </RouteDialog>
  );
}

function ConnectFooter(): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return <Button onClick={() => void close()}>{t('np.connect.done')}</Button>;
}
