import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderInputIcon,
  PlusIcon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import { moveKnowledgeDoc } from '../api-knowledge.js';
import { npKeys } from '../constants.js';
import type { KnowledgeDocSummary } from '../types-iter3.js';
import {
  buildKnowledgeTree,
  knowledgeSubtreeIds,
  nextKnowledgeSortOrder,
  type KnowledgeTreeNode,
} from './knowledge-model.js';

/**
 * The document tree (NP-147, `client/pages/np/README.md` §B): collapsible, the current document highlighted,
 * "New sub-document" per row and "Move to…" for whoever can edit the row's document. Reused by `/knowledge` (tree
 * view) and the project's "Knowledge" tab.
 */
export function KnowledgeTree({
  docs,
  currentDocId,
  linkSearch,
}: {
  readonly docs: readonly KnowledgeDocSummary[];
  readonly currentDocId?: string;
  /** Appended to a document's link, so the scope/search filters survive opening and closing it. */
  readonly linkSearch?: string;
}): ReactElement {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [moving, setMoving] = useState<KnowledgeDocSummary | null>(null);
  const nodes = buildKnowledgeTree(docs);

  function toggle(id: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className='space-y-0.5'>
      <ul role='tree' aria-label={t('np.knowledge.tree.label')}>
        {nodes.map((node) => (
          <KnowledgeTreeRow
            key={node.doc.id}
            node={node}
            depth={0}
            collapsed={collapsed}
            onToggle={toggle}
            currentDocId={currentDocId}
            linkSearch={linkSearch}
            onMove={setMoving}
          />
        ))}
      </ul>
      <MoveKnowledgeDialog
        doc={moving}
        docs={docs}
        onClose={() => setMoving(null)}
      />
    </div>
  );
}

function KnowledgeTreeRow({
  node,
  depth,
  collapsed,
  onToggle,
  currentDocId,
  linkSearch,
  onMove,
}: {
  readonly node: KnowledgeTreeNode;
  readonly depth: number;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly currentDocId?: string;
  readonly linkSearch?: string;
  readonly onMove: (doc: KnowledgeDocSummary) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { doc, children } = node;
  const isCurrent = doc.id === currentDocId;
  const isCollapsed = collapsed.has(doc.id);
  const hasChildren = children.length > 0;
  const newDocSearch = `?project=${encodeURIComponent(doc.projectId ?? 'workspace')}&parent=${encodeURIComponent(doc.id)}`;

  return (
    <li role='treeitem' aria-expanded={hasChildren ? !isCollapsed : undefined}>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-md py-1 pr-1 text-sm hover:bg-muted',
          isCurrent && 'bg-muted font-medium',
        )}
        style={{ paddingLeft: `${depth * 1.25 + 0.25}rem` }}
      >
        {hasChildren ? (
          <Button
            variant='ghost'
            size='icon-sm'
            className='shrink-0'
            aria-label={
              isCollapsed
                ? t('np.knowledge.tree.expand', { title: doc.title })
                : t('np.knowledge.tree.collapse', { title: doc.title })
            }
            aria-expanded={!isCollapsed}
            onClick={() => onToggle(doc.id)}
          >
            {isCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          </Button>
        ) : (
          <span className='size-7 shrink-0' aria-hidden='true' />
        )}
        <FileTextIcon
          className='size-3.5 shrink-0 text-muted-foreground'
          aria-hidden='true'
        />
        <Link
          to={{
            pathname: `/knowledge/${encodeURIComponent(doc.id)}`,
            search: linkSearch,
          }}
          {...(isCurrent ? { 'aria-current': 'page' as const } : {})}
          className='min-w-0 flex-1 truncate py-0.5 hover:underline'
        >
          {doc.title}
        </Link>
        {doc.archivedAt ? (
          <NpTag tone='slate'>{t('np.knowledge.archived')}</NpTag>
        ) : null}
        {(doc.childCount ?? children.length) > 0 ? (
          <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>
            {doc.childCount ?? children.length}
          </span>
        ) : null}
        {doc.canEdit && !doc.archivedAt ? (
          <div className='flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('np.knowledge.tree.newChild', {
                title: doc.title,
              })}
              nativeButton={false}
              render={
                <Link
                  to={{ pathname: '/knowledge/new', search: newDocSearch }}
                />
              }
            >
              <PlusIcon />
            </Button>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('np.knowledge.tree.moveTo', { title: doc.title })}
              onClick={() => onMove(doc)}
            >
              <FolderInputIcon />
            </Button>
          </div>
        ) : null}
      </div>
      {hasChildren && !isCollapsed ? (
        <ul role='group'>
          {children.map((child) => (
            <KnowledgeTreeRow
              key={child.doc.id}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              currentDocId={currentDocId}
              linkSearch={linkSearch}
              onMove={onMove}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * "Move to…" (NP-147): a new parent among the documents in the same scope, excluding the document's own subtree and
 * archived documents (the server rejects both). Always moves to the end of the new parent's children; reordering
 * among siblings is not part of this dialog.
 */
function MoveKnowledgeDialog({
  doc,
  docs,
  onClose,
}: {
  readonly doc: KnowledgeDocSummary | null;
  readonly docs: readonly KnowledgeDocSummary[];
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const move = useMutation({
    mutationFn: ({ parentId }: { readonly parentId: string | null }) => {
      if (!doc) throw new Error('No document to move.');
      return moveKnowledgeDoc(api, doc.id, {
        parentId,
        sortOrder: nextKnowledgeSortOrder(docs, parentId),
      });
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: t('np.knowledge.tree.moved', { title: doc?.title }),
      });
      onClose();
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError &&
                error.code === 'KNOWLEDGE_DEPTH_EXCEEDED'
              ? t('np.knowledge.tree.depthExceeded')
              : t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.knowledge }),
  });

  if (!doc) return <></>;

  const excluded = knowledgeSubtreeIds(docs, doc.id);
  const candidates = docs
    .filter((candidate) => !excluded.has(candidate.id) && !candidate.archivedAt)
    .filter((candidate) =>
      candidate.title.toLowerCase().includes(filter.trim().toLowerCase()),
    );
  const nodes = buildKnowledgeTree(candidates);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>
            {t('np.knowledge.tree.moveTitle', { title: doc.title })}
          </DialogTitle>
          <DialogDescription>
            {t('np.knowledge.tree.moveDescription')}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('np.knowledge.tree.moveFilter')}
          aria-label={t('np.knowledge.tree.moveFilter')}
        />
        <div
          role='listbox'
          aria-label={t('np.knowledge.tree.moveTitle', { title: doc.title })}
          className='max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-1'
        >
          <MoveTarget
            label={t('np.knowledge.tree.topLevel')}
            disabled={(doc.parentId ?? null) === null}
            pending={move.isPending}
            onSelect={() => move.mutate({ parentId: null })}
          />
          {nodes.map((node) => (
            <MoveCandidateRow
              key={node.doc.id}
              node={node}
              depth={0}
              currentParentId={doc.parentId ?? null}
              pending={move.isPending}
              onSelect={(parentId) => move.mutate({ parentId })}
            />
          ))}
        </div>
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>
            {t('actions.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MoveCandidateRow({
  node,
  depth,
  currentParentId,
  pending,
  onSelect,
}: {
  readonly node: KnowledgeTreeNode;
  readonly depth: number;
  readonly currentParentId: string | null;
  readonly pending: boolean;
  readonly onSelect: (parentId: string) => void;
}): ReactElement {
  return (
    <>
      <MoveTarget
        label={node.doc.title}
        depth={depth}
        disabled={currentParentId === node.doc.id}
        pending={pending}
        onSelect={() => onSelect(node.doc.id)}
      />
      {node.children.map((child) => (
        <MoveCandidateRow
          key={child.doc.id}
          node={child}
          depth={depth + 1}
          currentParentId={currentParentId}
          pending={pending}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function MoveTarget({
  label,
  depth = 0,
  disabled,
  pending,
  onSelect,
}: {
  readonly label: string;
  readonly depth?: number;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <button
      type='button'
      role='option'
      aria-selected={false}
      disabled={disabled || pending}
      onClick={onSelect}
      style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
      className='flex w-full items-center rounded-sm py-1.5 pr-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50'
    >
      <span className='truncate'>{label}</span>
    </button>
  );
}
