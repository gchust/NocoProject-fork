import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Outlet, useNavigate } from 'react-router';

import { NpShortcuts } from '@/components/np-shortcuts';
import { RuntimeTypeIcon } from '@/components/np-runtime-type';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { settingsCheck } from '../config/config-access.js';
import { npKeys } from '../constants.js';
import type { AgentsTopicPayload } from '../types.js';
import { useRealtimeTopic } from '../use-realtime.js';
import { BuiltinRuntimesSection } from './builtin-runtimes.js';
import { ComputerRuntimesSection } from './computer-runtimes.js';

/**
 * Route `/runtimes` (NP-219 §9.1): where agents work, in two blocks — computer runtimes (each computer's coding tools,
 * NP-188, and the computer credentials) and built-in runtimes (the AI plugin's model services in use). "Add runtime"
 * connects a computer or, for those who manage the general settings, uses a model service.
 */
export default function RuntimesPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  useRealtimeTopic<AgentsTopicPayload>('np:agents', () => {
    void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
    void queryClient.invalidateQueries({ queryKey: npKeys.agents });
    void queryClient.invalidateQueries({ queryKey: npKeys.computers });
  });

  return (
    <PageContainer>
      <PageHeader
        title={t('np.runtimes.title')}
        description={t('np.runtimes.description')}
        actions={<AddRuntimeMenu />}
      />
      <NpShortcuts />
      <div className='space-y-10'>
        <ComputerRuntimesSection />
        <BuiltinRuntimesSection />
      </div>
      <Outlet />
    </PageContainer>
  );
}

function AddRuntimeMenu(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canUseService = useCan(settingsCheck('general', 'update')).can;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button />}>
        <PlusIcon data-icon='inline-start' />
        {t('np.runtimeAdd.label')}
        <ChevronDownIcon data-icon='inline-end' />
      </DropdownMenuTrigger>
      {/* As wide as its entries need: the trigger is narrower than "Use a model service". */}
      <DropdownMenuContent
        align='end'
        className='w-auto min-w-(--anchor-width) whitespace-nowrap'
      >
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void navigate('connect')}>
            <RuntimeTypeIcon type='computer' />
            {t('np.runtimeAdd.computer')}
          </DropdownMenuItem>
          {canUseService ? (
            <DropdownMenuItem onClick={() => void navigate('builtin')}>
              <RuntimeTypeIcon type='builtin' />
              {t('np.runtimeAdd.builtin')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
