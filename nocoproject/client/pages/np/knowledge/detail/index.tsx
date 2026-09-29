import {
  ApiClientError,
  useApiClient,
  type ApiClient,
} from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PencilIcon,
  Undo2Icon,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpDetailLayout } from '@/components/np-detail-layout';
import { NpMarkdown } from '@/components/np-markdown';
import { extractMarkdownHeadings } from '@/components/np-markdown-toc';
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
import type { KnowledgeDetail, KnowledgeDoc } from '../../types-iter3.js';
import { useWorkspaceViewer } from '../../use-workspace-viewer.js';
import { canEditKnowledge } from '../knowledge-model.js';
import { KnowledgeDiff } from '../knowledge-diff.js';
import { KnowledgeProposalCard } from '../proposal-card.js';
import { KnowledgeEditor } from './knowledge-editor.js';
import { KnowledgeSidePanel } from './side-panel.js';
import { KnowledgeToc } from './toc.js';

/**
 * Route `/knowledge/:docId` (§B): one document as a covering page in the three-column detail frame. The main column
 * shows the Markdown (or the rich-text editor, which saves with `expectedVersion` and reports a conflict), pending
 * agent proposals for it, and — when the side panel's history is used — a line diff of the two versions picked
 * (a version against the one right before it by default, or any two by the picker below the history, NP-142). A
 * table of contents appears once the body has 3+ headings.
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

/** Two versions being compared (§3): `from` may be 0, meaning "nothing before the first version" (empty content). */
interface CompareState {
  readonly from: number;
  readonly to: number;
}

/** A version's content: the current one needs no request, `0` (no earlier version) is empty, otherwise fetched. */
function useVersionContent(
  api: ApiClient,
  doc: KnowledgeDoc,
  version: number | null,
): { readonly content: string | undefined; readonly isError: boolean } {
  const fetchable = version !== null && version > 0 && version !== doc.version;
  const query = useQuery({
    queryKey: npKeys.knowledgeVersion(doc.id, version ?? 0),
    queryFn: ({ signal }) =>
      fetchKnowledgeVersion(api, doc.id, version ?? 0, signal),
    enabled: fetchable,
  });
  if (version === null) return { content: undefined, isError: false };
  if (version === 0) return { content: '', isError: false };
  if (version === doc.version) return { content: doc.content, isError: false };
  return { content: query.data?.content, isError: query.isError };
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
  const [compare, setCompare] = useState<CompareState | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const headings = useMemo(
    () => extractMarkdownHeadings(doc.content),
    [doc.content],
  );
  const compareFrom = useVersionContent(api, doc, compare?.from ?? null);
  const compareTo = useVersionContent(api, doc, compare?.to ?? null);
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
                  setCompare(null);
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
      ) : compare ? (
        <div className='space-y-3'>
          <Alert>
            <AlertDescription>
              {compare.from === 0
                ? t('np.knowledge.comparingFromNew', { to: compare.to })
                : t('np.knowledge.comparingVersions', {
                    from: compare.from,
                    to: compare.to,
                  })}
            </AlertDescription>
            <AlertAction>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setCompare(null)}
              >
                <Undo2Icon data-icon='inline-start' />
                {t('np.knowledge.backToCurrent')}
              </Button>
            </AlertAction>
          </Alert>
          {compareFrom.isError || compareTo.isError ? (
            <p className='text-sm text-destructive'>
              {t('np.common.requestFailed')}
            </p>
          ) : compareFrom.content === undefined ||
            compareTo.content === undefined ? (
            <p className='text-sm text-muted-foreground'>
              {t('status.loading')}
            </p>
          ) : (
            <KnowledgeDiff
              before={compareFrom.content}
              after={compareTo.content}
            />
          )}
        </div>
      ) : (
        <>
          <KnowledgeToc headings={headings} className='lg:hidden' />
          <Card>
            <CardContent>
              {doc.content.trim() ? (
                <NpMarkdown content={doc.content} headings={headings} />
              ) : (
                <p className='text-sm text-muted-foreground'>
                  {t('np.knowledge.emptyContent')}
                </p>
              )}
            </CardContent>
          </Card>
        </>
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
          headings={editing || compare ? [] : headings}
          highlightedVersion={compare?.to ?? doc.version}
          onSelectVersion={(version) => {
            setEditing(false);
            setCompare(
              version === doc.version
                ? null
                : { from: version - 1, to: version },
            );
          }}
          onCompareVersions={(from, to) => {
            setEditing(false);
            setCompare({ from, to });
          }}
        />
      }
    />
  );
}
