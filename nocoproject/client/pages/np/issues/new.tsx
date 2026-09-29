import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { NpTabBar } from '@/components/np-route-tabs';
import { RouteDialog } from '@/components/route-dialog';

import { BatchesList } from '../intake/batches-list.js';
import { IntakeBatchView, IntakeComposer } from '../intake/intake-panels.js';
import { ManualIssueFooter, ManualIssueForm } from './new-manual.js';
import {
  type NewIssueTab,
  newIssueCloseSearch,
  readStoredNewIssueTab,
  resolveNewIssueTab,
  storeNewIssueTab,
} from './new-issue-model.js';

/**
 * Route `/issues/new`: "New issue", one dialog for one issue or many (iteration 4 §D). Two tabs, the last one used
 * remembered (localStorage) and `?tab=` overriding:
 *
 * - **AI draft** (the default): describe the work or paste a list or meeting notes, choose the project, "Draft
 *   issues" sends it to batch entry's parser (`POST /np/intake/batches`), and the drafts open in batch entry's
 *   table — with a Process column — to create one issue or many. The draft batch sits in `?batch=` so a reload
 *   keeps it; the viewer's recent batches are listed under the composer.
 * - **Manual**: the single-issue form.
 *
 * `?project=` preselects the project in both. The old batch-entry links (`/issues/intake`, `/projects/:id/intake`,
 * `/intake`) redirect here on the AI tab. Closing drops `tab` and `batch` and returns to the list underneath.
 */
export default function NewIssuePage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [stored, setStored] = useState(() => readStoredNewIssueTab());
  const tab = resolveNewIssueTab(params, stored);
  const batchId = tab === 'ai' ? params.get('batch') : null;
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const handleSubmittingChange = (value: boolean): void => {
    submittingRef.current = value;
    setSubmitting(value);
  };

  function changeTab(next: NewIssueTab): void {
    storeNewIssueTab(next);
    setStored(next);
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', next);
    setParams(nextParams, { replace: true });
  }

  function setBatch(id: string | null): void {
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', 'ai');
    if (id) nextParams.set('batch', id);
    else nextParams.delete('batch');
    setParams(nextParams);
  }

  return (
    <RouteDialog
      title={t('np.newIssue.title')}
      // The drafts table needs the width; the composer and the form read better narrow.
      className={
        tab === 'manual'
          ? 'sm:max-w-xl'
          : batchId
            ? 'sm:max-w-5xl'
            : 'sm:max-w-2xl'
      }
      closeTo={{ pathname: '..', search: newIssueCloseSearch(location.search) }}
      beforeClose={() => !submittingRef.current}
      footer={
        tab === 'manual' ? (
          <ManualIssueFooter submitting={submitting} />
        ) : undefined
      }
    >
      <div className='space-y-4'>
        <NpTabBar
          idPrefix='np-new-issue'
          label={t('np.newIssue.tabsLabel')}
          value={tab}
          onChange={changeTab}
          tabs={[
            { value: 'ai', label: t('np.newIssue.tabs.ai') },
            { value: 'manual', label: t('np.newIssue.tabs.manual') },
          ]}
        />
        <div
          role='tabpanel'
          id={`np-new-issue-panel-${tab}`}
          aria-labelledby={`np-new-issue-tab-${tab}`}
        >
          {tab === 'manual' ? (
            <ManualIssueForm onSubmittingChange={handleSubmittingChange} />
          ) : batchId ? (
            <IntakeBatchView
              key={batchId}
              batchId={batchId}
              onClose={() => setBatch(null)}
            />
          ) : (
            <div className='space-y-6'>
              <IntakeComposer
                initialProjectId={params.get('project')}
                onParsed={(id) => setBatch(id)}
              />
              <BatchesList onOpen={(id) => setBatch(id)} />
            </div>
          )}
        </div>
      </div>
    </RouteDialog>
  );
}
