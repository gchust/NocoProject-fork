import { useTranslation } from '@nocobase/i18n/client';
import { CheckIcon, PaletteIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { LABEL_COLORS, LABEL_DOT_CLASS } from '@/pages/np/constants';
import type { Label, LabelColor } from '@/pages/np/types';

/**
 * Recolor labels (iteration 1 leftover "label color picker"): each label with the seven palette colors as swatches. The color
 * name is the swatch's accessible name, so the choice does not rest on color alone.
 */
export function NpLabelColorPicker({
  labels,
  disabled,
  onChange,
}: {
  readonly labels: readonly Label[];
  readonly disabled?: boolean;
  readonly onChange: (label: Label, color: LabelColor) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant='ghost'
            size='icon-xs'
            disabled={disabled || labels.length === 0}
            aria-label={t('np.labelColors.open')}
          />
        }
      >
        <PaletteIcon />
      </PopoverTrigger>
      <PopoverContent align='end' className='w-64 gap-2 p-2'>
        <PopoverTitle className='px-1 text-xs font-medium text-muted-foreground'>
          {t('np.labelColors.title')}
        </PopoverTitle>
        <ul className='space-y-1.5'>
          {labels.map((label) => (
            <li key={label.id} className='flex items-center gap-2 px-1'>
              <span className='min-w-0 flex-1 truncate text-sm'>
                {label.name}
              </span>
              <div
                role='radiogroup'
                aria-label={t('np.labelColors.for', { name: label.name })}
                className='flex gap-1'
              >
                {LABEL_COLORS.map((color) => (
                  <button
                    key={color}
                    type='button'
                    role='radio'
                    aria-checked={label.color === color}
                    aria-label={t(`np.labelColors.colors.${color}`)}
                    title={t(`np.labelColors.colors.${color}`)}
                    onClick={() => {
                      if (label.color !== color) onChange(label, color);
                    }}
                    className={cn(
                      'flex size-4 items-center justify-center rounded-full ring-offset-1 ring-offset-popover outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      LABEL_DOT_CLASS[color],
                      label.color === color && 'ring-2 ring-foreground/60',
                    )}
                  >
                    {label.color === color ? (
                      <CheckIcon
                        className='size-3 text-background'
                        aria-hidden='true'
                      />
                    ) : null}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
