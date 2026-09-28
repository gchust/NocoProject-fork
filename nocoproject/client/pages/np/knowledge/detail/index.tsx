import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PencilIcon,
  Undo2Icon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link, useParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpDetailLayout } from '@/components/np-detail-layout';
import { NpMarkdown } from '@/components/np-markdown';
import { NpDetailSkeleton, NpLoadError } from '@/components/np-states';
import { PageHeader } from '@/components/page-header';
import { RouteChildPage } from '@/components/route-child-page';
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

import {
  fetchKnowledgeDetail,
  fetchKnowledgeVersion,
  setKnowledgeArchived,
} from '../../api-knowledge.js';
import { fetchProjects } from '../../api.js';
import { npKeys } from '../../constants.js';
import type { KnowledgeDetail } from '../../types-iter3.js';
import { useWorkspaceViewer } from '../../use-workspace-viewer.js';
import { canEditKnowledge } from '../knowledge-model.js';
import { KnowledgeProposalCard } from '../proposal-card.js';
import { KnowledgeEditor } from './knowledge-editor.js';
import { KnowledgeSidePanel } from './side-panel.js';

/**
 * Route `/knowledge/:docId` (§B): one document as a covering page in the three-column detail frame. The main column
 * shows the Markdown (or the rich-text editor, which saves with `expectedVersion` and reports a conflict), pending
 * agent proposals for it, and — when a past version is picked in the side panel — that version read-only. The side
 * panel holds the document's details and its version history.
 */
export default function KnowledgeDetailPage(): ReactElement {
  const { docId = '' } = useParams();
  return (
    <RouteChildPage>
      <KnowledgeDetailView key={docId} docId={docId} />
    </RouteChildPage>
  );
}

function KnowledgeDetailView({
  docId,
}: {
  readonly docId: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const detail = useQuery({
    queryKey: npKeys.knowledgeDoc(docId),
    queryFn: ({ signal }) => fetchKnowledgeDetail(api, docId, signal),
    retry: (count, error) =>
      !(error instanceof ApiClientError && [403, 404].includes(error.status)) &&
      count < 2,
  });
  if (detail.isError && !detail.data) {
    return (
      <div className='space-y-4 p-6 md:p-8'>
        <Breadcrumbs />
        <NpLoadError
          title={t('np.knowledge.detailLoadFailed')}
          error={detail.error}
          action={
            <Button
              variant='outline'
              size='sm'
              nativeButton={false}
              render={<Link to='..' relative='path' />}
            >
              {t('np.knowledge.backToList')}
            </Button>
          }
        />
      </div>
    );
  }
  if (!detail.data) return <NpDetailSkeleton />;
  return <KnowledgeLayout detail={detail.data} />;
}

function KnowledgeLayout({
  detail,
}: {
  readonly detail: KnowledgeDetail;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { doc } = detail;
  const { viewer } = useWorkspaceViewer();
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const canEdit = canEditKnowledge(doc, viewer, projects.data);
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const version = useQuery({
    queryKey: npKeys.knowledgeVersion(doc.id, viewing ?? 0),
    queryFn: ({ signal }) =>
      fetchKnowledgeVersion(api, doc.id, viewing ?? 0, signal),
    enabled: viewing !== null && viewing !== doc.version,
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      setKnowledgeArchived(api, doc.id, archived),
    onSuccess: (_, archived) =>
      toast.add({
        type: 'success',
        title: archived
          ? t('np.knowledge.archivedToast', { title: doc.title })
          : t('np.knowledge.unarchivedToast', { title: doc.title }),
      }),
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.knowledge }),
  });
  const pastVersion =
    viewing !== null && viewing !== doc.version ? viewing : null;

  const main = (
    <div className='space-y-6 p-6 md:p-8'>
      <Breadcrumbs />
      <PageHeader
        title={doc.title}
        description={doc.summary ?? undefined}
        actions={
          canEdit && !editing ? (
            <>
              <Button
                variant='outline'
                onClick={() =>
                  doc.archivedAt
                    ? archive.mutate(false)
                    : setConfirmArchive(true)
                }
                disabled={archive.isPending}
              >
                {doc.archivedAt ? (
                  <ArchiveRestoreIcon data-icon='inline-start' />
                ) : (
                  <ArchiveIcon data-icon='inline-start' />
                )}
                {doc.archivedAt
                  ? t('np.knowledge.unarchive')
                  : t('np.knowledge.archive')}
              </Button>
              <Button
                disabled={Boolean(doc.archivedAt)}
                onClick={() => {
                  setViewing(null);
                  setEditing(true);
                }}
              >
                <PencilIcon data-icon='inline-start' />
                {t('np.knowledge.edit')}
              </Button>
            </>
          ) : undefined
        }
      />
      {doc.archivedAt ? (
        <NpTag tone='slate'>{t('np.knowledge.archived')}</NpTag>
      ) : null}
      {detail.proposals.length > 0 ? (
        <section
          className='space-y-3'
          aria-labelledby='np-knowledge-doc-proposals'
        >
          <h2
            id='np-knowledge-doc-proposals'
            className='font-heading text-sm font-semibold'
          >
            {t('np.knowledge.proposals.title', {
              count: detail.proposals.length,
            })}
          </h2>
          {detail.proposals.map((proposal) => (
            <KnowledgeProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </section>
      ) : null}
      {editing ? (
        <KnowledgeEditor doc={doc} onDone={() => setEditing(false)} />
      ) : pastVersion !== null ? (
        <div className='space-y-3'>
          <Alert>
            <AlertDescription>
              {t('np.knowledge.viewingVersion', { version: pastVersion })}
            </AlertDescription>
            <AlertAction>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setViewing(null)}
              >
                <Undo2Icon data-icon='inline-start' />
                {t('np.knowledge.backToCurrent')}
              </Button>
            </AlertAction>
          </Alert>
          <Card>
            <CardContent>
              {version.data ? (
                <NpMarkdown content={version.data.content} />
              ) : version.isError ? (
                <p className='text-sm text-destructive'>
                  {t('np.common.requestFailed')}
                </p>
              ) : (
                <p className='text-sm text-muted-foreground'>
                  {t('status.loading')}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent>
            {doc.content.trim() ? (
              <NpMarkdown content={doc.content} />
            ) : (
              <p className='text-sm text-muted-foreground'>
                {t('np.knowledge.emptyContent')}
              </p>
            )}
          </CardContent>
        </Card>
      )}
      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.knowledge.archiveTitle', { title: doc.title })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.knowledge.archiveDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                setConfirmArchive(false);
                archive.mutate(true);
              }}
            >
              {t('np.knowledge.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  return (
    <NpDetailLayout
      main={main}
      asideLabel={t('np.knowledge.sidePanel')}
      aside={
        <KnowledgeSidePanel
          detail={detail}
          projectName={
            doc.projectId
              ? (doc.projectName ??
                projects.data?.find((project) => project.id === doc.projectId)
                  ?.name ??
                doc.projectId)
              : t('np.knowledge.workspace')
          }
          viewing={viewing ?? doc.version}
          onView={(value) => {
            setEditing(false);
            setViewing(value === doc.version ? null : value);
          }}
        />
      }
    />
  );
}
