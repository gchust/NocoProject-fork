import { useTranslation } from '@nocobase/i18n/client';
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { toast } from '@/components/ui/toast';

/**
 * A write-only secret field with a show / hide toggle and, while it holds a value, a copy button — so a generated
 * webhook secret can be pasted into `gh webhook forward` before it is saved and never shown again.
 */
export function SecretInput({
  id,
  value,
  placeholder,
  visible,
  onVisibleChange,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.connect.copyFailed'),
      });
    }
  }

  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete='off'
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        className={visible ? 'font-mono text-xs' : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <InputGroupAddon align='inline-end'>
        {value ? (
          <InputGroupButton
            size='icon-xs'
            aria-label={copied ? t('np.connect.copied') : t('np.connect.copy')}
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </InputGroupButton>
        ) : null}
        <InputGroupButton
          size='icon-xs'
          aria-pressed={visible}
          aria-label={
            visible ? t('np.githubSecrets.hide') : t('np.githubSecrets.show')
          }
          onClick={() => onVisibleChange(!visible)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
