import { useTranslation } from '@nocobase/i18n/client';
import { BotIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

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
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import type { StartDecision } from '@/pages/np/types';

export interface NpStartRequest {
  /** The agents the change would trigger (the executor, today always one). */
  readonly agentNames: readonly string[];
  readonly issueIdentifier?: string;
  /** The issue's current `autoExecuteSubtasks`, which seeds the switch. */
  readonly autoExecuteSubtasks: boolean;
}

/**
 * "Confirm start" (§G): shown before a change that would queue an agent run. "Start" and "Don't start now" both
 * apply the change, the second with `start: false`; closing the dialog abandons the change, which the caller undoes
 * (a board card snaps back). The `autoExecuteSubtasks` switch is sent with either answer.
 *
 * A single-decision confirmation, so it is component state rather than a route overlay
 * (`references/frontend/references/overlay.md`).
 */
export function NpStartDialog({
  request,
  onDecide,
  onCancel,
}: {
  readonly request: NpStartRequest | null;
  readonly onDecide: (decision: StartDecision) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  // The last request stays rendered while the dialog animates closed, so the title does not flicker.
  const [shown, setShown] = useState<NpStartRequest | null>(request);
  const [autoExecute, setAutoExecute] = useState(
    request?.autoExecuteSubtasks ?? false,
  );
  if (request && request !== shown) {
    setShown(request);
    setAutoExecute(request.autoExecuteSubtasks);
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('np.start.title')}</DialogTitle>
          <DialogDescription>
            {shown?.issueIdentifier
              ? t('np.start.descriptionFor', {
                  identifier: shown.issueIdentifier,
                })
              : t('np.start.description')}
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <p className='text-sm font-medium'>{t('np.start.agents')}</p>
            <ul className='space-y-1'>
              {(shown?.agentNames ?? []).map((name) => (
                <li key={name} className='flex items-center gap-2 text-sm'>
                  <BotIcon
                    className='size-4 text-muted-foreground'
                    aria-hidden='true'
                  />
                  {name}
                </li>
              ))}
            </ul>
          </div>
          <Field orientation='horizontal'>
            <FieldContent>
              <FieldLabel htmlFor='np-start-auto-execute'>
                {t('np.start.autoExecute')}
              </FieldLabel>
              <FieldDescription>
                {t('np.start.autoExecuteHint')}
              </FieldDescription>
            </FieldContent>
            <Switch
              id='np-start-auto-execute'
              checked={autoExecute}
              onCheckedChange={setAutoExecute}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() =>
              onDecide({ start: false, autoExecuteSubtasks: autoExecute })
            }
          >
            {t('np.start.later')}
          </Button>
          <Button
            onClick={() =>
              onDecide({ start: true, autoExecuteSubtasks: autoExecute })
            }
          >
            {t('np.start.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
