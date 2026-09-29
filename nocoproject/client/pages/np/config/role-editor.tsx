import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import type { AccessCatalog } from '../types-roles.js';
import {
  accessTitle,
  type BusinessChoice,
  offersAll,
  offersRelated,
  PAGE_TITLES,
  relatedAccessOf,
  type RoleDraft,
} from './roles-model.js';

function toggled(
  set: ReadonlySet<string>,
  key: string,
  on: boolean,
): Set<string> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

function CheckItem({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label
      htmlFor={id}
      className='flex min-h-8 items-center gap-2 text-sm has-disabled:text-muted-foreground'
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
  );
}

type BusinessItem = AccessCatalog['business'][number];

function BusinessActionRow({
  item,
  action,
  choice,
  readOnly,
  relatedLabel,
  onChange,
}: {
  readonly item: BusinessItem;
  readonly action: BusinessItem['actions'][number];
  readonly choice: BusinessChoice;
  readonly readOnly: boolean;
  readonly relatedLabel: (key: string | undefined) => string;
  readonly onChange: (choice: BusinessChoice) => void;
}): ReactElement {
  const { t } = useTranslation();
  const key = `${item.id}/${action.name}`;
  const label = accessTitle(t, action.title, action.name);
  const related = offersRelated(action);
  const all = offersAll(action);
  const scoped = related || all;
  const items = [
    ...(related
      ? [{ value: 'related', label: relatedLabel(relatedAccessOf(action)) }]
      : []),
    ...(all ? [{ value: 'all', label: t('np.roles.scopeAll') }] : []),
  ];
  const switchId = `np-role-business-${key}`;
  return (
    <div className='flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-2'>
      <label htmlFor={switchId} className='flex items-center gap-3 text-sm'>
        <Switch
          id={switchId}
          checked={choice !== 'off'}
          disabled={readOnly}
          onCheckedChange={(on) =>
            onChange(on ? (related || !all ? 'related' : 'all') : 'off')
          }
        />
        {label}
      </label>
      {scoped && choice !== 'off' ? (
        <Select
          items={items}
          value={choice}
          disabled={readOnly || items.length < 2}
          onValueChange={(value: string | null) => {
            if (value === 'related' || value === 'all') onChange(value);
          }}
        >
          <SelectTrigger
            size='sm'
            className='w-48'
            aria-label={t('np.roles.scopeFor', { name: label })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

/**
 * What a business role holds, in three groups (NP-153): the NocoProject pages it opens, the actions on each settings
 * item, and the business actions — a switch each, then its data scope: NocoProject's own rules ("related": the
 * records NocoProject relates to the holder, as each action describes) or every record. Only what `GET
 * /np/access/catalog` offers is listed; platform resources never are.
 */
export function RoleEditor({
  catalog,
  draft,
  readOnly,
  onChange,
}: {
  readonly catalog: AccessCatalog;
  readonly draft: RoleDraft;
  readonly readOnly: boolean;
  readonly onChange: (draft: RoleDraft) => void;
}): ReactElement {
  const { t } = useTranslation();
  const recordAccess = new Map(
    catalog.recordAccess.map((entry) => [entry.key, entry.title]),
  );
  const relatedLabel = (key: string | undefined): string => {
    const title = key ? recordAccess.get(key) : null;
    return title ? accessTitle(t, title, key!) : t('np.roles.scopeRelated');
  };
  return (
    <div className='space-y-6'>
      <Card>
        <CardHeader>
          <CardTitle>{t('np.roles.groups.pages')}</CardTitle>
        </CardHeader>
        <CardContent className='grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3'>
          {catalog.pages.map((id) => (
            <CheckItem
              key={id}
              id={`np-role-page-${id}`}
              label={PAGE_TITLES[id] ? t(PAGE_TITLES[id]) : id}
              checked={draft.pages.has(id)}
              disabled={readOnly}
              onChange={(on) =>
                onChange({ ...draft, pages: toggled(draft.pages, id, on) })
              }
            />
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('np.roles.groups.settings')}</CardTitle>
        </CardHeader>
        <CardContent className='divide-y'>
          {catalog.settings.map((item) => (
            <div
              key={item.id}
              className='flex flex-wrap items-center gap-x-6 gap-y-1 py-2 first:pt-0 last:pb-0'
            >
              <span className='w-48 text-sm font-medium'>
                {accessTitle(t, item.title, item.id)}
              </span>
              {item.actions.map((action) => {
                const key = `${item.id}/${action.name}`;
                return (
                  <CheckItem
                    key={key}
                    id={`np-role-settings-${key}`}
                    label={accessTitle(t, action.title, action.name)}
                    checked={draft.settings.has(key)}
                    disabled={readOnly}
                    onChange={(on) =>
                      onChange({
                        ...draft,
                        settings: toggled(draft.settings, key, on),
                      })
                    }
                  />
                );
              })}
            </div>
          ))}
          <p className='pt-3 text-xs text-muted-foreground'>
            {t('np.roles.defineRolesNote')}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('np.roles.groups.business')}</CardTitle>
        </CardHeader>
        <CardContent className='space-y-5'>
          {catalog.business.map((item) => (
            <div key={item.id} className='space-y-1'>
              <h3 className='text-sm font-semibold'>
                {accessTitle(t, item.title, item.id)}
              </h3>
              <div className='divide-y'>
                {item.actions.map((action) => {
                  const key = `${item.id}/${action.name}`;
                  return (
                    <BusinessActionRow
                      key={key}
                      item={item}
                      action={action}
                      choice={draft.business[key] ?? 'off'}
                      readOnly={readOnly}
                      relatedLabel={relatedLabel}
                      onChange={(choice) =>
                        onChange({
                          ...draft,
                          business: { ...draft.business, [key]: choice },
                        })
                      }
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
