import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { ConnectComputerSteps } from '@/components/connect-computer-steps';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { ChimePreferenceSection } from './chime-preference.js';
import { PmAgentSection } from './pm-agent-section.js';
import { PmConfirmPreference } from './pm-confirm-preference.js';
import { ProfileForm, PasswordForm } from './profile-forms.js';

export default function ProfilePage(): ReactElement {
  const { client, session } = useAuthentication();
  const { t } = useTranslation();
  const profile = useQuery({
    queryKey: ['account-profile', session?.user.id],
    queryFn: async () => {
      const result = await client.getSession({
        query: { disableCookieCache: true },
      });
      if (result.error) throw new Error('Profile request failed');
      return result.data?.user ?? null;
    },
    retry: false,
    gcTime: 0,
    // Load fresh data on entry, but never replace a draft while its owner is typing.
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  return (
    <PageContainer>
      <PageHeader
        title={t('account.profile')}
        description={t('profile.description')}
      />
      {profile.isPending ? (
        <div
          role='status'
          aria-label={t('status.loading')}
          className='space-y-4'
        >
          <Skeleton className='h-64' />
          <Skeleton className='h-64' />
        </div>
      ) : profile.isError && !profile.data ? (
        <Alert variant='destructive'>
          <AlertDescription>{t('profile.loadFailed')}</AlertDescription>
          <Button
            variant='outline'
            onClick={() => void profile.refetch()}
            disabled={profile.isFetching}
          >
            {t('status.retry')}
          </Button>
        </Alert>
      ) : !profile.data ? (
        <Alert>
          <AlertDescription>{t('profile.signInAgain')}</AlertDescription>
          <Button
            variant='outline'
            nativeButton={false}
            render={<Link to='/login' />}
          >
            {t('auth.signIn')}
          </Button>
        </Alert>
      ) : (
        <>
          {profile.isError && (
            <Alert variant='destructive'>
              <AlertDescription>{t('profile.reloadFailed')}</AlertDescription>
              <Button
                variant='outline'
                onClick={() => void profile.refetch()}
                disabled={profile.isFetching}
              >
                {t('status.retry')}
              </Button>
            </Alert>
          )}
          <ProfileForm key={profile.data.id} user={profile.data} />
          <PasswordForm />
          <ChimePreferenceSection />
          <PmAgentSection />
          <PmConfirmPreference />
          <Card>
            <CardHeader>
              <CardTitle>{t('profile.computer')}</CardTitle>
              <CardDescription>
                {t('profile.computerDescription')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ConnectComputerSteps />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('profile.apiKeys')}</CardTitle>
              <CardDescription>
                {t('profile.apiKeysDescription')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant='outline'
                nativeButton={false}
                render={<Link to='/settings/api-keys' />}
              >
                {t('profile.apiKeysLink')}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
