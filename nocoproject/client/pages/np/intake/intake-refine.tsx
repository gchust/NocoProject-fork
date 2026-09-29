import { useTranslation } from '@nocobase/i18n/client';
import { SparklesIcon, Undo2Icon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpSectionHeading } from '@/components/np-section';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';

import {
  type IntakeRefineState,
  REFINE_INSTRUCTION_MAX,
} from './use-intake-refine.js';

/** The "Ask AI to revise" block under the drafts table. */
export function IntakeRefine({
  state,
  disabled,
}: {
  readonly state: IntakeRefineState;
  readonly disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { instruction, revisions, pending } = state;
  const tooLong = instruction.length > REFINE_INSTRUCTION_MAX;
  const latestKey = [...revisions].reverse().find((item) => !item.undone)?.key;

  return (
    <section
      className='space-y-3 rounded-lg border bg-card p-4 text-card-foreground'
      aria-labelledby='np-intake-refine-heading'
    >
      <NpSectionHeading
        id='np-intake-refine-heading'
        title={
          <>
            <SparklesIcon className='size-4' aria-hidden='true' />
            {t('np.intakeRefine.title')}
          </>
        }
      />
      {revisions.length > 0 ? (
        <ol
          className='space-y-1 text-sm'
          aria-label={t('np.intakeRefine.history')}
        >
          {revisions.map((item) => (
            <li
              key={item.key}
              className='flex min-w-0 items-center justify-between gap-3'
            >
              <span
                className={
                  item.undone
                    ? 'min-w-0 truncate text-muted-foreground line-through'
                    : 'min-w-0 truncate'
                }
                title={item.instruction}
              >
                {item.instruction}
              </span>
              <span className='flex shrink-0 items-center gap-1 text-muted-foreground'>
                {item.undone
                  ? t('np.intakeRefine.undoneTag')
                  : t('np.intakeRefine.revisedTag')}
                {item.key === latestKey ? (
                  <Button
                    variant='ghost'
                    size='sm'
                    disabled={disabled}
                    onClick={state.undo}
                  >
                    <Undo2Icon data-icon='inline-start' />
                    {t('np.intakeRefine.undo')}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <Field data-invalid={tooLong ? true : undefined}>
        <FieldLabel htmlFor='np-intake-refine' className='sr-only'>
          {t('np.intakeRefine.label')}
        </FieldLabel>
        <Textarea
          id='np-intake-refine'
          value={instruction}
          rows={2}
          disabled={disabled}
          placeholder={t('np.intakeRefine.placeholder')}
          onChange={(event) => state.setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              state.submit();
            }
          }}
        />
        {tooLong ? (
          <FieldError>
            {t('np.intakeRefine.tooLong', { max: REFINE_INSTRUCTION_MAX })}
          </FieldError>
        ) : null}
      </Field>
      <div className='flex justify-end'>
        <Button
          variant='outline'
          disabled={disabled || !instruction.trim() || tooLong}
          onClick={state.submit}
        >
          {pending ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <SparklesIcon data-icon='inline-start' />
          )}
          {pending
            ? t('np.intakeRefine.submitting')
            : t('np.intakeRefine.submit')}
        </Button>
      </div>
    </section>
  );
}
