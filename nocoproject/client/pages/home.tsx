import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';
import { Navigate } from 'react-router';

/**
 * The landing page. NocoProject's sidebar (plan §3.1) starts at the inbox, so a viewer who may open it is forwarded
 * there; anyone else (a signed-in user without NocoProject grants) keeps the template's welcome text.
 */
export default function HomePage(): ReactElement | null {
  const { t } = useTranslation();
  const inbox = useCan({
    resource: { type: 'page', id: 'np-inbox' },
    action: 'access',
  });
  if (inbox.can) return <Navigate replace to='/inbox' />;
  if (inbox.isPending) return null;
  return (
    <section className='grid min-h-[calc(100svh-4rem)] w-full place-items-center px-6 py-10'>
      <div className='max-w-xl space-y-6 text-center'>
        <h1 className='font-heading text-3xl font-semibold tracking-tight'>
          {t('home.title')}
        </h1>
        <p className='text-muted-foreground'>{t('home.description')}</p>
      </div>
    </section>
  );
}
