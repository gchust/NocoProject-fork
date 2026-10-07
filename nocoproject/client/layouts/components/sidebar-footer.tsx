import { Trans } from 'react-i18next';
import { useTranslation } from '@nocobase/i18n/client';
import { ShieldCheck } from 'lucide-react';
import type { ReactElement } from 'react';

import { SidebarFooter as SidebarFooterSlot } from '@/components/ui/sidebar';

export function SidebarFooter(): ReactElement {
  const { t } = useTranslation();
  const templateName =
    typeof __PORTAL_TEMPLATE_NAME__ === 'string'
      ? __PORTAL_TEMPLATE_NAME__
      : 'Default Template';
  const templateVersion =
    typeof __PORTAL_TEMPLATE_VERSION__ === 'string'
      ? __PORTAL_TEMPLATE_VERSION__
      : '0.0.0';
  const templateLabel = `${templateName} v${templateVersion}`;
  const brandLink = (
    <a
      className='rounded-sm font-medium text-sidebar-foreground hover:underline outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring'
      href='https://www.nocobase.com'
      rel='noopener noreferrer'
      target='_blank'
    >
      NocoBase
    </a>
  );

  return (
    // NP-236: the shadcn sidebar's footer slot; the icon mode keeps only the shield.
    <SidebarFooterSlot className='shrink-0 gap-0 border-t border-sidebar-border/70 p-0'>
      <div
        className='flex min-h-20 items-center gap-3 px-5 py-3 group-data-[collapsible=icon]:min-h-16 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2'
        title={templateLabel}
      >
        <ShieldCheck className='size-4 shrink-0 text-sidebar-foreground/80' />
        <div className='min-w-0 text-xs leading-4 group-data-[collapsible=icon]:hidden'>
          <div className='font-semibold text-sidebar-foreground'>
            {t('shell.buildFreely', { defaultValue: 'AI builds freely.' })}
          </div>
          <div className='text-sidebar-foreground/80'>
            <Trans
              t={t}
              i18nKey='shell.reliability'
              defaults='<brand>NocoBase</brand> keeps it reliable.'
              components={{
                brand: brandLink,
              }}
            >
              {brandLink} keeps it reliable.
            </Trans>
          </div>
          <div className='mt-1 font-mono text-xs text-sidebar-foreground/70'>
            {templateLabel}
          </div>
        </div>
      </div>
    </SidebarFooterSlot>
  );
}
