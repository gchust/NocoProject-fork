import { useApiClient } from '@nocobase/app-client';
import {
  useAuthorizationClient,
  useCan,
} from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useEffect, useRef, type ReactElement } from 'react';
import { Navigate } from 'react-router';

import { fetchMe } from './np/api.js';

/**
 * The landing page. NocoProject's sidebar (plan §3.1) starts at the inbox, so a viewer who may open it is forwarded
 * there; anyone else (a signed-in user without NocoProject grants) keeps the template's welcome text.
 *
 * NP-153: the page grants live in the business roles, and a newcomer gets `np-member` on their first NocoProject
 * request (`ensureMember`). A viewer who may not open the inbox therefore makes that request once (`GET /np/me`) and
 * then reads their permissions again; someone whose roles were revoked stays on the welcome text.
 */
export default function HomePage(): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const authorization = useAuthorizationClient();
  const enteredRef = useRef(false);
  const inbox = useCan({
    resource: { type: 'page', id: 'np-inbox' },
    action: 'access',
  });
  const refused = !inbox.can && !inbox.isPending;
  useEffect(() => {
    if (!refused || enteredRef.current) return;
    enteredRef.current = true;
    void fetchMe(api)
      .then(() => authorization.invalidate())
      .catch(() => undefined);
  }, [refused, api, authorization]);
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
