import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { type FormEvent, type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { UnsavedChangesBoundary } from '@/components/unsaved-changes';
import {
  useGuardedClose,
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from '@/components/use-unsaved-changes';

import {
  envNameProblem,
  envValueTooLong,
  setAgentEnv,
} from '../../api-agent-extras.js';
import type { AgentEnvVarValue } from '../../types.js';

/**
 * Add a variable (`target.name === null`) or replace one's value. The value field starts empty: stored values are
 * never sent to the browser except through the audited reveal.
 */
export function EnvVarDialog({
  agentId,
  target,
  existingNames,
  onClose,
  onSaved,
}: {
  readonly agentId: string;
  readonly target: { readonly name: string | null } | null;
  readonly existingNames: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const unsaved = useUnsavedChangesGuard();
  const requestClose = useGuardedClose(unsaved, onClose);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>
            {target?.name
              ? t('np.envVars.editTitle', { name: target.name })
              : t('np.envVars.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('np.envVars.writeOnly')}</DialogDescription>
        </DialogHeader>
        <UnsavedChangesBoundary guard={unsaved}>
          {target ? (
            <EnvForm
              key={target.name ?? 'new'}
              agentId={agentId}
              fixedName={target.name}
              existingNames={existingNames}
              onClose={onClose}
              onCancel={requestClose}
              onSaved={onSaved}
            />
          ) : null}
        </UnsavedChangesBoundary>
      </DialogContent>
    </Dialog>
  );
}

function EnvForm({
  agentId,
  fixedName,
  existingNames,
  onClose,
  onCancel,
  onSaved,
}: {
  readonly agentId: string;
  readonly fixedName: string | null;
  readonly existingNames: readonly string[];
  readonly onClose: () => void;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [name, setName] = useState(fixedName ?? '');
  const [value, setValue] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [valueError, setValueError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(value !== '' || (!fixedName && name.trim() !== ''));

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    const problem = fixedName ? null : envNameProblem(trimmed);
    const duplicate = !fixedName && existingNames.includes(trimmed);
    setNameError(
      problem
        ? t(`np.envVars.nameProblems.${problem}`)
        : duplicate
          ? t('np.envVars.nameProblems.duplicate')
          : undefined,
    );
    setValueError(
      envValueTooLong(value) ? t('np.envVars.valueTooLong') : undefined,
    );
    if (problem || duplicate || envValueTooLong(value)) return;
    setSaving(true);
    try {
      await setAgentEnv(api, agentId, [{ name: trimmed, value }]);
      toast.add({
        type: 'success',
        title: t('np.envVars.saved', { name: trimmed }),
      });
      onSaved();
      onClose();
    } catch (error: unknown) {
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.code === 'RESERVED_ENV_NAME'
            ? t('np.envVars.nameProblems.reserved')
            : error instanceof ApiClientError && error.status === 403
              ? t('np.common.forbidden')
              : t('np.common.requestFailed'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <FieldGroup>
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor='np-env-name'>{t('np.envVars.name')}</FieldLabel>
          <Input
            id='np-env-name'
            value={name}
            readOnly={fixedName !== null}
            autoFocus={fixedName === null}
            autoComplete='off'
            spellCheck={false}
            placeholder='GITHUB_TOKEN'
            className='font-mono'
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => setName(event.target.value.toUpperCase())}
          />
          {nameError ? (
            <FieldError>{nameError}</FieldError>
          ) : (
            <FieldDescription>{t('np.envVars.nameHint')}</FieldDescription>
          )}
        </Field>
        <Field data-invalid={valueError ? true : undefined}>
          <FieldLabel htmlFor='np-env-value'>
            {t('np.envVars.value')}
          </FieldLabel>
          <Textarea
            id='np-env-value'
            value={value}
            rows={3}
            autoFocus={fixedName !== null}
            autoComplete='off'
            spellCheck={false}
            className='font-mono text-xs'
            aria-invalid={valueError ? true : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
          {valueError ? <FieldError>{valueError}</FieldError> : null}
        </Field>
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            disabled={saving}
            onClick={onCancel}
          >
            {t('actions.cancel')}
          </Button>
          <Button type='submit' disabled={saving}>
            {saving ? <Spinner data-icon='inline-start' /> : null}
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** The revealed values, held only in this dialog's props and dropped when it closes. */
export function RevealedDialog({
  values,
  onClose,
}: {
  readonly values: readonly AgentEnvVarValue[] | null;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog
      open={values !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{t('np.envVars.revealedTitle')}</DialogTitle>
          <DialogDescription>{t('np.envVars.revealedNote')}</DialogDescription>
        </DialogHeader>
        <dl className='max-h-[50svh] space-y-2 overflow-y-auto text-sm'>
          {(values ?? []).map((item) => (
            <div key={item.name} className='space-y-0.5'>
              <dt className='font-mono text-xs text-muted-foreground'>
                {item.name}
              </dt>
              <dd className='rounded-md bg-muted px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap select-all'>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <Button onClick={onClose}>{t('actions.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
