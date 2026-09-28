import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type ReactElement, useEffect, useRef, useState } from 'react';

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';

import { fetchIssues } from '../api.js';
import { npKeys } from '../constants.js';
import type { IssueListItem } from '../types.js';

/**
 * Searches issues by title or identifier (`GET /np/issues?q=`, 300 ms after typing stops) and reports the one picked.
 * Issues in `exclude` (the issue itself, existing dependencies) are left out. The input clears after a pick.
 */
export function IssuePicker({
  id,
  exclude,
  disabled,
  placeholder,
  onPick,
  'aria-label': ariaLabel,
}: {
  readonly id?: string;
  readonly exclude: ReadonlySet<string>;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly onPick: (issue: IssueListItem) => void;
  readonly 'aria-label'?: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const filters = { q: query || undefined };
  const results = useQuery({
    queryKey: npKeys.issueList(filters),
    queryFn: ({ signal }) => fetchIssues(api, filters, signal),
    placeholderData: keepPreviousData,
  });
  const items = (results.data ?? [])
    .filter((issue) => !exclude.has(issue.id))
    .slice(0, 20);

  return (
    <Combobox
      items={items}
      value={null}
      disabled={disabled}
      inputValue={input}
      // The server already matched the text; filtering again by label would hide identifier matches.
      filter={null}
      itemToStringLabel={(issue: IssueListItem) =>
        `${issue.identifier} ${issue.title}`
      }
      onInputValueChange={(value) => {
        setInput(value);
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setQuery(value.trim()), 300);
      }}
      onValueChange={(issue: IssueListItem | null) => {
        if (!issue) return;
        onPick(issue);
        setInput('');
        setQuery('');
      }}
    >
      <ComboboxInput
        id={id}
        className='w-full'
        aria-label={ariaLabel}
        placeholder={placeholder ?? t('np.issuePicker.placeholder')}
        disabled={disabled}
      />
      <ComboboxContent>
        <ComboboxEmpty>{t('np.issuePicker.empty')}</ComboboxEmpty>
        <ComboboxList>
          {(issue: IssueListItem) => (
            <ComboboxItem key={issue.id} value={issue}>
              <span className='shrink-0 font-mono text-xs text-muted-foreground'>
                {issue.identifier}
              </span>
              <span className='truncate'>{issue.title}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
