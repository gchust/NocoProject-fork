import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { DatePicker } from '@/components/date-picker';
import { NpLabelName } from '@/components/np-labels';
import { NpMultiSelect } from '@/components/np-multi-select';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';

import { createLabel } from '../../api-collab.js';
import { LABEL_COLORS, npKeys } from '../../constants.js';
import { fromDateOnly, toDateOnly, useDateFnsLocale } from '../../format.js';
import type { Label } from '../../types.js';

export function PropertyRow({
  label,
  htmlFor,
  children,
}: {
  readonly label: ReactNode;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className='grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-sm'>
      {htmlFor ? (
        <label htmlFor={htmlFor} className='text-muted-foreground'>
          {label}
        </label>
      ) : (
        <span className='text-muted-foreground'>{label}</span>
      )}
      <div className='min-w-0'>{children}</div>
    </div>
  );
}

export interface SimpleOption {
  readonly value: string;
  readonly label: string;
}

/** A compact select for a property; `none` stands for an empty value. */
export function PropertySelect({
  id,
  options,
  value,
  noneLabel,
  noneAsDash = false,
  disabled,
  size = 'sm',
  className,
  'aria-label': ariaLabel,
  onChange,
}: {
  readonly id: string;
  /** Width of the trigger; full width by default. */
  readonly className?: string;
  readonly 'aria-label'?: string;
  readonly options: readonly SimpleOption[];
  readonly value: string | null | undefined;
  readonly noneLabel?: string;
  /** Show an empty value as a muted dash in the trigger (properties panels); the list keeps `noneLabel`. */
  readonly noneAsDash?: boolean;
  readonly disabled?: boolean;
  /** `sm` for the compact properties panel, `default` inside a form. */
  readonly size?: 'sm' | 'default';
  readonly onChange: (value: string | null) => void;
}): ReactElement {
  const items = [
    ...(noneLabel ? [{ value: 'none', label: noneLabel }] : []),
    ...options,
  ];
  const selected = value ?? 'none';
  if (!items.some((item) => item.value === selected)) {
    items.push({ value: selected, label: selected });
  }
  return (
    <Select
      items={items}
      value={selected}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === null || next === selected) return;
        onChange(next === 'none' ? null : next);
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        className={className ?? 'w-full'}
        aria-label={ariaLabel}
      >
        <SelectValue>
          {(current: string) =>
            noneAsDash && current === 'none' ? (
              <span className='text-muted-foreground'>
                —<span className='sr-only'>{noneLabel}</span>
              </span>
            ) : (
              (items.find((item) => item.value === current)?.label ?? current)
            )
          }
        </SelectValue>
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

/** A calendar date with a clear button; values are `YYYY-MM-DD`. */
export function DateField({
  id,
  value,
  disabled,
  clearLabel,
  size = 'sm',
  onChange,
}: {
  readonly id: string;
  readonly value: string | null | undefined;
  readonly disabled?: boolean;
  readonly clearLabel: string;
  readonly size?: 'sm' | 'default';
  readonly onChange: (value: string | null) => void;
}): ReactElement {
  const locale = useDateFnsLocale();
  return (
    <div className='flex items-center gap-1'>
      <DatePicker
        id={id}
        className={
          size === 'sm' ? 'h-7 w-full min-w-0 text-sm' : 'w-full min-w-0'
        }
        value={fromDateOnly(value)}
        locale={locale}
        formatString='PP'
        disabled={disabled}
        // An empty date shows a dash; the row's label names the field (nocosolution/NocoSolution 前端规范.md §6).
        placeholder='—'
        onChange={(date) => onChange(toDateOnly(date))}
      />
      {value ? (
        <Button
          variant='ghost'
          size='icon-xs'
          aria-label={clearLabel}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}

/** A color for a new label, spread over the palette by name so labels created in a row differ. */
function colorFor(name: string): Label['color'] {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[hash % LABEL_COLORS.length];
}

/** Labels as a chips multi-select; typing a new name creates the label (§J 2). */
export function LabelsField({
  id,
  labels,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly labels: readonly Label[];
  readonly value: readonly string[];
  readonly disabled?: boolean;
  readonly onChange: (labelIds: string[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();

  async function create(name: string): Promise<string | undefined> {
    try {
      const label = await createLabel(api, { name, color: colorFor(name) });
      queryClient.setQueryData<Label[]>(npKeys.labels, (current) => [
        ...(current ?? []),
        label,
      ]);
      void queryClient.invalidateQueries({ queryKey: npKeys.labels });
      return label.id;
    } catch {
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.labels.createFailed'),
      });
      return undefined;
    }
  }

  return (
    <NpMultiSelect
      id={id}
      aria-label={t('np.properties.labels')}
      options={labels.map((label) => ({
        value: label.id,
        label: label.name,
        render: <NpLabelName label={label} />,
      }))}
      value={value}
      disabled={disabled}
      placeholder={t('np.labels.placeholder')}
      emptyText={t('np.labels.empty')}
      onCreate={create}
      onChange={onChange}
    />
  );
}
