import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { NpStatusBadge } from '@/components/np-badges';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { searchIssues } from '@/pages/np/api-iter3';
import { npKeys } from '@/pages/np/constants';

import { isEditableTarget, isSearchShortcut } from './np-shortcut-keys.js';

/**
 * The ⌘K issue search (§H 7): a command dialog over `GET /np/issues?q=`, searching titles and identifiers. Results
 * come from the server, so the command list does not filter them again; Enter opens the highlighted issue.
 */
export function NpSearchDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: npKeys.issueSearch(query),
    queryFn: ({ signal }) => searchIssues(api, query, signal),
    enabled: open && query !== '',
    placeholderData: keepPreviousData,
  });

  function select(issueId: string): void {
    onOpenChange(false);
    setText('');
    void navigate(`/issues/${encodeURIComponent(issueId)}`);
  }

  const items = query ? (results.data ?? []) : [];
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('np.search.title')}
      description={t('np.search.description')}
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={text}
          onValueChange={setText}
          placeholder={t('np.search.placeholder')}
          aria-label={t('np.search.title')}
        />
        <CommandList>
          {results.isFetching ? (
            <div className='flex justify-center py-3'>
              <Spinner
                className='size-4 text-muted-foreground'
                aria-label={t('status.loading')}
              />
            </div>
          ) : null}
          <CommandEmpty>
            {query ? t('np.search.noResults') : t('np.search.hint')}
          </CommandEmpty>
          {items.length > 0 ? (
            <CommandGroup heading={t('np.search.issues')}>
              {items.map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={issue.id}
                  onSelect={() => select(issue.id)}
                >
                  <span className='w-16 shrink-0 font-mono text-xs text-muted-foreground'>
                    {issue.identifier}
                  </span>
                  <span className='min-w-0 flex-1 truncate'>{issue.title}</span>
                  <NpStatusBadge statusKey={issue.statusKey} />
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/**
 * The keyboard shortcuts of the NocoProject pages (§H 7): `C` creates an issue, ⌘K / Ctrl+K opens the search. Each
 * top-level NocoProject page renders one (the pages are siblings, so exactly one listens at a time). `C` is ignored
 * while typing or while a dialog is open. `showTrigger` also renders a search button for pointer users.
 */
export function NpShortcuts({
  onCreate,
  showTrigger = false,
}: {
  /** Replaces the default "go to /issues/new", for a page that opens its own create dialog. */
  readonly onCreate?: () => void;
  readonly showTrigger?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const onCreateRef = useRef(onCreate);
  useEffect(() => {
    onCreateRef.current = onCreate;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      if (isSearchShortcut(event)) {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key !== 'c' && event.key !== 'C') return;
      if (isEditableTarget(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      event.preventDefault();
      if (onCreateRef.current) onCreateRef.current();
      else void navigate('/issues/new');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  return (
    <>
      {showTrigger ? (
        <Button
          variant='outline'
          className='text-muted-foreground'
          onClick={() => setOpen(true)}
        >
          <SearchIcon data-icon='inline-start' />
          {t('np.search.trigger')}
          <Kbd data-icon='inline-end' aria-hidden='true'>
            ⌘K
          </Kbd>
        </Button>
      ) : null}
      <NpSearchDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
