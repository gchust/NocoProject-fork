import { useTranslation } from '@nocobase/i18n/client';
import { KanbanSquareIcon, ListIcon, SearchIcon, XIcon } from 'lucide-react';
import type { ReactElement, ReactNode, RefObject } from 'react';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import type { IssueFilterKey, IssueView } from './filters.js';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** A select whose `all` item means "no filter"; an unknown value in the URL shows as `all`. */
function FilterSelect({
  label,
  allLabel,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly options: readonly FilterOption[];
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
}): ReactElement {
  const items = [{ value: 'all', label: allLabel }, ...options];
  const selected =
    value && options.some((option) => option.value === value) ? value : 'all';
  return (
    <Select
      items={items}
      value={selected}
      onValueChange={(next) =>
        onChange(next && next !== 'all' ? next : undefined)
      }
    >
      <SelectTrigger className='w-40' aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface IssueToolbarFilter {
  readonly key: IssueFilterKey;
  readonly label: string;
  readonly allLabel: string;
  readonly options: readonly FilterOption[];
  readonly value: string | undefined;
}

/**
 * Search, filters and the list/board switch above the issues (§J 1, 7). Everything writes to the query string
 * through the page; the search box keeps its own text and reports it (see `use-url-search.ts`).
 */
export function IssueToolbar({
  searchRef,
  searchText,
  onSearchTextChange,
  onSearchSettled,
  filters,
  view,
  hasFilters,
  fetching,
  onFilterChange,
  onViewChange,
  onClear,
  extra,
}: {
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly searchText: string;
  readonly onSearchTextChange: (value: string) => void;
  /** Called with text that is not mid-composition, to schedule the URL write. */
  readonly onSearchSettled: (value: string) => void;
  readonly filters: readonly IssueToolbarFilter[];
  readonly view: IssueView;
  readonly hasFilters: boolean;
  readonly fetching: boolean;
  readonly onFilterChange: (
    key: IssueFilterKey,
    value: string | undefined,
  ) => void;
  readonly onViewChange: (view: IssueView) => void;
  readonly onClear: () => void;
  readonly extra?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <InputGroup className='w-full sm:w-64'>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          value={searchText}
          placeholder={t('np.issues.searchPlaceholder')}
          aria-label={t('np.issues.searchLabel')}
          onChange={(event) => {
            onSearchTextChange(event.target.value);
            if (!(event.nativeEvent as InputEvent).isComposing) {
              onSearchSettled(event.target.value);
            }
          }}
          onCompositionEnd={(event) =>
            onSearchSettled(event.currentTarget.value)
          }
        />
      </InputGroup>
      {filters.map((filter) => (
        <FilterSelect
          key={filter.key}
          label={filter.label}
          allLabel={filter.allLabel}
          options={filter.options}
          value={filter.value}
          onChange={(value) => onFilterChange(filter.key, value)}
        />
      ))}
      {hasFilters ? (
        <Button variant='ghost' size='sm' onClick={onClear}>
          <XIcon data-icon='inline-start' />
          {t('np.common.clearFilters')}
        </Button>
      ) : null}
      {fetching ? (
        <Spinner
          className='size-4 text-muted-foreground'
          aria-label={t('status.loading')}
        />
      ) : null}
      {extra}
      <ToggleGroup
        variant='outline'
        size='sm'
        spacing={0}
        className='ml-auto'
        value={[view]}
        onValueChange={(values: string[]) => {
          const [next] = values;
          if (next === 'list' || next === 'board') onViewChange(next);
        }}
        aria-label={t('np.board.viewLabel')}
      >
        <ToggleGroupItem value='list' aria-label={t('np.board.listView')}>
          <ListIcon />
        </ToggleGroupItem>
        <ToggleGroupItem value='board' aria-label={t('np.board.boardView')}>
          <KanbanSquareIcon />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
