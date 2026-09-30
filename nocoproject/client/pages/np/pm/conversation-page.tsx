import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';

import { NpShortcuts } from '@/components/np-shortcuts';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';

import { PmAgentBadge } from './conversation/pm-agent-status.js';
import { PmConversationView } from './conversation/pm-conversation-view.js';
import {
  usePmConversationDetail,
  usePmTitle,
} from './conversation/use-pm-conversation.js';

/**
 * Route `/pm/:conversationId` (NP-185): one conversation at full width, filling the content area like `/issues`
 * (README §1) — the same view as the drawer. `/pm/new` is a new conversation; its first message creates it and
 * the URL moves to the new id.
 */
export default function PmConversationPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { conversationId = 'new' } = useParams();
  const id = conversationId === 'new' ? null : conversationId;
  const detail = usePmConversationDetail(id);
  const pmTitle = usePmTitle();
  return (
    <PageContainer className='flex h-full min-h-0 flex-col gap-6 space-y-0'>
      <PageHeader
        title={
          detail.data
            ? pmTitle(detail.data.title)
            : t('np.pmAssistant.newConversation')
        }
        description={
          detail.data?.agent ? (
            <PmAgentBadge agent={detail.data.agent} />
          ) : undefined
        }
        actions={<NpShortcuts />}
      />
      <div className='min-h-0 flex-1'>
        <PmConversationView
          key={id ?? 'new'}
          conversationId={id}
          onConversation={(created) =>
            void navigate(`/pm/${encodeURIComponent(created)}`, {
              replace: true,
            })
          }
          onStartNew={() => void navigate('/pm/new')}
        />
      </div>
    </PageContainer>
  );
}
