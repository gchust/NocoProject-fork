import { useTranslation } from '@nocobase/i18n/client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { AlertCircleIcon, Settings2Icon, UnplugIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpOnlineState } from '@/components/np-badges';
import { RuntimeTypeTag } from '@/components/np-runtime-type';
import { NpTag } from '@/components/np-tag';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import { settingsCheck } from '../../config/config-access.js';
import type { PmConversationAgent } from '../../types-pm.js';
import { runtimeTypeOf } from '../../types-runtime-types.js';
import { isAgentDown, isAgentUnreachable } from './pm-conversation-model.js';

/** The conversation's agent: its name, where it comes from, and whether its computer is online (§5.4, §6.5). */
export function PmAgentBadge({
  agent,
}: {
  readonly agent: PmConversationAgent;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span className='flex min-w-0 items-center gap-1.5'>
      <span
        className='truncate text-xs text-muted-foreground'
        title={agent.name}
      >
        {agent.name}
      </span>
      <RuntimeTypeTag
        type={runtimeTypeOf(agent)}
        iconOnly
        data-testid='np-pm-agent-type'
      />
      <NpTag tone={agent.source === 'personal' ? 'violet' : 'grey'}>
        {t(`np.pmAssistant.agent.source.${agent.source}`)}
      </NpTag>
      {agent.compat === 'upgrade_required' ? (
        <NpTag tone='amber'>{t('np.pmAssistant.agent.needsUpgrade')}</NpTag>
      ) : (
        <NpOnlineState online={agent.online} />
      )}
    </span>
  );
}

/**
 * Why a down agent cannot answer, in the words of its type (NP-219): a computer is offline or needs an upgrade; a
 * built-in agent's model service is unavailable, with the reason the runtime reports.
 */
function downTitle(
  agent: PmConversationAgent,
  t: (key: string, options?: Record<string, unknown>) => string,
  kind: 'personal' | 'default',
): string {
  if (runtimeTypeOf(agent) === 'builtin') {
    return t('np.runtimeType.serviceUnavailable', {
      reason: agent.statusReason
        ? t(`np.builtinRuntimes.reasons.${agent.statusReason}`)
        : t('np.common.offline'),
    });
  }
  const upgrade = agent.compat === 'upgrade_required';
  if (kind === 'personal')
    return t(
      upgrade
        ? 'np.pmAssistant.agent.upgradeRequired'
        : 'np.pmAssistant.agent.offline',
    );
  return t(
    upgrade
      ? 'np.pmAssistant.agent.defaultUpgradeRequired'
      : 'np.pmAssistant.agent.defaultOffline',
  );
}

/**
 * The notices above the composer about who will answer (§6.5): the personal agent is offline (use the default for
 * this conversation), the conversation is on the default for now (return to my project manager), or nobody can
 * answer (no project manager configured; the settings link only for those who may change them).
 */
export function PmAgentNotice({
  agent,
  notConfigured,
  busy,
  onFallback,
  onRestore,
}: {
  readonly agent: PmConversationAgent | null;
  readonly notConfigured: boolean;
  readonly busy: boolean;
  readonly onFallback: () => void;
  readonly onRestore: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const canConfigure = useCan(settingsCheck('general', 'update')).can;
  if (notConfigured) {
    return (
      <Alert variant='destructive' data-testid='np-pm-not-configured'>
        <AlertCircleIcon />
        <AlertTitle>{t('np.pmAssistant.notConfigured')}</AlertTitle>
        <AlertDescription>{t('np.pmAssistant.messageKept')}</AlertDescription>
        {canConfigure ? (
          <AlertAction>
            <Button
              variant='outline'
              size='sm'
              nativeButton={false}
              render={<Link to='/config/general' />}
            >
              <Settings2Icon data-icon='inline-start' />
              {t('np.pm.openSettings')}
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    );
  }
  if (!agent) return null;
  if (isAgentUnreachable(agent)) {
    return (
      <Alert data-testid='np-pm-agent-offline'>
        <UnplugIcon />
        <AlertTitle>{downTitle(agent, t, 'personal')}</AlertTitle>
        {runtimeTypeOf(agent) === 'builtin' ? null : (
          <AlertDescription>
            {t('np.pmAssistant.agent.queued')}
          </AlertDescription>
        )}
        <AlertAction>
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={onFallback}
          >
            {busy ? <Spinner data-icon='inline-start' /> : null}
            {t('np.pmAssistant.agent.fallback')}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (isAgentDown(agent)) {
    // The default (or the default for now) is down: nothing to switch to, the message waits for it.
    return (
      <Alert data-testid='np-pm-default-down'>
        <UnplugIcon />
        <AlertTitle>{downTitle(agent, t, 'default')}</AlertTitle>
        {runtimeTypeOf(agent) === 'builtin' ? null : (
          <AlertDescription>
            {t('np.pmAssistant.agent.queued')}
          </AlertDescription>
        )}
      </Alert>
    );
  }
  if (agent.source === 'fallback') {
    return (
      <div
        className='flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground'
        data-testid='np-pm-agent-fallback'
      >
        <span className='mr-auto'>
          {t('np.pmAssistant.agent.usingDefault')}
        </span>
        {agent.personalAvailable ? (
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={onRestore}
          >
            {busy ? <Spinner data-icon='inline-start' /> : null}
            {t('np.pmAssistant.agent.restore')}
          </Button>
        ) : null}
      </div>
    );
  }
  return null;
}
