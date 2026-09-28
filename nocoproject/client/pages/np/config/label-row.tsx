import { useTranslation } from '@nocobase/i18n/client';
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';

import { NpLabelDot } from '@/components/np-labels';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { LABEL_COLORS, LABEL_DOT_CLASS } from '../constants.js';
import type { Label, LabelColor } from '../types.js';

/** The seven palette colors as a radio group of swatches; the color name is each swatch's accessible name. */
export function ColorSwatches({
  value,
  label,
  disabled,
  onChange,
}: {
  readonly value: LabelColor;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onChange: (color: LabelColor) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div role='radiogroup' aria-label={label} className='flex gap-1'>
      {LABEL_COLORS.map((color) => (
        <button
          key={color}
          type='button'
          role='radio'
          aria-checked={value === color}
          aria-label={t(`np.labelColors.colors.${color}`)}
          title={t(`np.labelColors.colors.${color}`)}
          disabled={disabled}
          onClick={() => {
            if (value !== color) onChange(color);
          }}
          className={cn(
            'flex size-5 items-center justify-center rounded-full ring-offset-1 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            LABEL_DOT_CLASS[color],
            value === color && 'ring-2 ring-foreground/60',
          )}
        >
          {value === color ? (
            <CheckIcon className='size-3 text-background' aria-hidden='true' />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** One label in the settings table: inline rename, color swatches, and delete behind a confirmation. */
export function LabelRow({
  label,
  canEdit,
  busy,
  onRename,
  onRecolor,
  onDelete,
}: {
  readonly label: Label;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onRename: (name: string) => void;
  readonly onRecolor: (color: LabelColor) => void;
  readonly onDelete: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);
  const [confirming, setConfirming] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed && trimmed !== label.name) onRename(trimmed);
    setEditing(false);
  }

  return (
    <TableRow>
      <TableCell className='min-w-48'>
        {editing ? (
          <form onSubmit={submit} className='flex items-center gap-1'>
            <Input
              value={name}
              maxLength={50}
              autoFocus
              aria-label={t('np.config.labels.renameLabel', {
                name: label.name,
              })}
              className='h-8 w-48'
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setName(label.name);
                  setEditing(false);
                }
              }}
            />
            <Button
              type='submit'
              variant='ghost'
              size='icon-sm'
              aria-label={t('actions.save')}
            >
              <CheckIcon />
            </Button>
            <Button
              type='button'
              variant='ghost'
              size='icon-sm'
              aria-label={t('actions.cancel')}
              onClick={() => {
                setName(label.name);
                setEditing(false);
              }}
            >
              <XIcon />
            </Button>
          </form>
        ) : (
          <span className='inline-flex items-center gap-2 font-medium'>
            <NpLabelDot color={label.color} />
            {label.name}
          </span>
        )}
      </TableCell>
      <TableCell>
        {canEdit ? (
          <ColorSwatches
            value={label.color}
            label={t('np.labelColors.for', { name: label.name })}
            disabled={busy}
            onChange={onRecolor}
          />
        ) : (
          <span className='text-sm text-muted-foreground'>
            {t(`np.labelColors.colors.${label.color}`)}
          </span>
        )}
      </TableCell>
      {canEdit ? (
        <TableCell>
          <div className='flex justify-end gap-1'>
            <Button
              variant='ghost'
              size='icon-sm'
              disabled={busy}
              aria-label={t('np.config.labels.renameLabel', {
                name: label.name,
              })}
              onClick={() => {
                setName(label.name);
                setEditing(true);
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              variant='ghost'
              size='icon-sm'
              disabled={busy}
              aria-label={t('np.config.labels.deleteLabel', {
                name: label.name,
              })}
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon />
            </Button>
          </div>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('np.config.labels.deleteTitle', { name: label.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('np.config.labels.deleteDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  variant='destructive'
                  onClick={() => {
                    setConfirming(false);
                    onDelete();
                  }}
                >
                  {t('np.config.labels.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
