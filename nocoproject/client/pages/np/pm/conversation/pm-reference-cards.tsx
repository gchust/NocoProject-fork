import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { BookOpenIcon, FolderKanbanIcon, SquareCheckIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';

import { NpStatusBadge } from '@/components/np-badges';
import { NpTag } from '@/components/np-tag';

import { fetchIssueDetail } from '../../api.js';
import { searchIssues } from '../../api-iter3.js';
import { fetchKnowledgeDetail } from '../../api-knowledge.js';
import { fetchProject } from '../../api-projects.js';
import { npKeys } from '../../constants.js';
import { type PmReference, referencesIn } from './pm-conversation-model.js';

/**
 * The tasks, projects and knowledge documents a message mentions, as cards under it (NP-185): identifier, title and
 * state, a link to the page. Each card reads the same cached detail the page does; one that cannot be read (no
 * access, deleted) renders nothing and the mention stays plain text in the message.
 */
export function PmReferenceCards({
  content,
}: {
  readonly content: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const references = referencesIn(content);
  if (references.length === 0) return null;
  return (
    <ul
      className='mt-2 flex flex-col gap-1.5'
      aria-label={t('np.pmAssistant.references.label')}
    >
      {references.map((reference) => (
        <ReferenceCard key={reference.key} reference={reference} />
      ))}
    </ul>
  );
}

function ReferenceCard({
  reference,
}: {
  readonly reference: PmReference;
}): ReactElement | null {
  if (reference.type === 'project') return <ProjectCard id={reference.value} />;
  if (reference.type === 'knowledgeDoc')
    return <KnowledgeCard id={reference.value} />;
  return /^[A-Z][A-Z0-9]*-\d+$/u.test(reference.value) ? (
    <IssueByIdentifierCard identifier={reference.value} />
  ) : (
    <IssueByIdCard id={reference.value} />
  );
}

const QUIET = { retry: false, staleTime: 30_000 } as const;

function IssueByIdentifierCard({
  identifier,
}: {
  readonly identifier: string;
}): ReactElement | null {
  const api = useApiClient();
  const search = useQuery({
    queryKey: npKeys.issueSearch(identifier),
    queryFn: ({ signal }) => searchIssues(api, identifier, signal),
    ...QUIET,
  });
  const issue = search.data?.find((item) => item.identifier === identifier);
  if (!issue) return null;
  return (
    <Card
      to={`/issues/${encodeURIComponent(issue.id)}`}
      icon={<SquareCheckIcon aria-hidden='true' />}
      identifier={issue.identifier}
      title={issue.title}
      tag={<NpStatusBadge statusKey={issue.statusKey} />}
    />
  );
}

function IssueByIdCard({ id }: { readonly id: string }): ReactElement | null {
  const api = useApiClient();
  const detail = useQuery({
    queryKey: npKeys.issue(id),
    queryFn: ({ signal }) => fetchIssueDetail(api, id, signal),
    ...QUIET,
  });
  const issue = detail.data?.issue;
  if (!issue || issue.originType === 'pm') return null;
  return (
    <Card
      to={`/issues/${encodeURIComponent(issue.id)}`}
      icon={<SquareCheckIcon aria-hidden='true' />}
      identifier={issue.identifier}
      title={issue.title}
      tag={
        <NpStatusBadge
          statusKey={issue.statusKey}
          catalog={detail.data?.statusCatalog}
        />
      }
    />
  );
}

function ProjectCard({ id }: { readonly id: string }): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const project = useQuery({
    queryKey: npKeys.project(id),
    queryFn: ({ signal }) => fetchProject(api, id, signal),
    ...QUIET,
  });
  if (!project.data) return null;
  return (
    <Card
      to={`/projects/${encodeURIComponent(project.data.id)}`}
      icon={<FolderKanbanIcon aria-hidden='true' />}
      title={project.data.name}
      tag={<NpTag tone='grey'>{t('np.pmAssistant.references.project')}</NpTag>}
    />
  );
}

function KnowledgeCard({ id }: { readonly id: string }): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const detail = useQuery({
    queryKey: npKeys.knowledgeDoc(id),
    queryFn: ({ signal }) => fetchKnowledgeDetail(api, id, signal),
    ...QUIET,
  });
  const doc = detail.data?.doc;
  if (!doc) return null;
  return (
    <Card
      to={`/knowledge/${encodeURIComponent(doc.id)}`}
      icon={<BookOpenIcon aria-hidden='true' />}
      title={doc.title}
      tag={
        <NpTag tone='grey'>{t('np.pmAssistant.references.knowledge')}</NpTag>
      }
    />
  );
}

function Card({
  to,
  icon,
  identifier,
  title,
  tag,
}: {
  readonly to: string;
  readonly icon: ReactNode;
  readonly identifier?: string | null;
  readonly title: string;
  readonly tag: ReactNode;
}): ReactElement {
  return (
    <li>
      <Link
        to={to}
        className='flex min-h-9 min-w-0 items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground'
      >
        {icon}
        {identifier ? (
          <span className='shrink-0 font-mono text-xs text-muted-foreground'>
            {identifier}
          </span>
        ) : null}
        <span className='min-w-0 flex-1 truncate' title={title}>
          {title}
        </span>
        {tag}
      </Link>
    </li>
  );
}
