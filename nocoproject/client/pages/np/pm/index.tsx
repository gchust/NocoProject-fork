import { useTranslation } from '@nocobase/i18n/client';
import { SquarePenIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

import { NpShortcuts } from '@/components/np-shortcuts';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

import { PmHistoryList } from './history/pm-history-list.js';

/**
 * Route `/pm` (NP-185, `protocol-pm-assistant.md` §11.2): the member's conversation history with the project
 * manager — the same list as the drawer's history view. A row opens `/pm/:conversationId`; "New conversation"
 * opens an empty one there, created by its first message.
 */
export default function PmHistoryPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <PageContainer>
      <PageHeader
        title={t('navigation.pm')}
        description={t('np.pmAssistant.history.description')}
        actions={
          <>
            <NpShortcuts />
            <Button onClick={() => void navigate('/pm/new')}>
              <SquarePenIcon data-icon='inline-start' />
              {t('np.pmAssistant.newConversation')}
            </Button>
          </>
        }
      />
      <PmHistoryList
        onOpen={(id) => void navigate(`/pm/${encodeURIComponent(id)}`)}
      />
    </PageContainer>
  );
}
