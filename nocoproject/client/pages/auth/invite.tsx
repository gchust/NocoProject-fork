import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { usePasswordLogin } from '@nocobase/app-plugin-authentication/client/actions';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';

import { AuthLayout } from '../../extensions/nocobase-auth-ui/components/auth-layout.js';
import { FormStatus } from '../../extensions/nocobase-auth-ui/components/form-status.js';
import { acceptInvitation, lookupInvitation } from '../np/api-invitations.js';
import type { PublicInvitation } from '../np/types-invitations.js';
import { authLogo, authMarketing } from './shared.js';

const MIN_PASSWORD = 8;

/** The error key for a lookup or acceptance refusal (`np.invite.errors.*`). */
function errorKey(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 404) return 'notFound';
    if (error.code === 'INVITATION_EXPIRED') return 'expired';
    if (error.code === 'INVITATION_ACCEPTED') return 'accepted';
    if (error.code === 'INVITATION_REVOKED') return 'revoked';
    if (error.code === 'INVALID_PASSWORD') return 'password';
    if (error.code === 'ACCOUNT_CONFLICT') return 'accountConflict';
  }
  return 'failed';
}

function LoginLink(): ReactElement {
  const { t } = useTranslation();
  return (
    <Button className='w-full' render={<Link to='/login' />}>
      {t('np.invite.goToLogin')}
    </Button>
  );
}

/**
 * Route `/invite/:token` (NP-88, `auth: 'optional'`): the page an invitation email links to. It shows who invited
 * the visitor into which projects, takes a name and a password, creates the account through the public acceptance
 * endpoint and then signs in with the authentication plugin's password action. A visitor who is already signed in
 * is asked to sign out first, so an invitation is never accepted into the wrong session.
 */
export default function InvitePage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const { token = '' } = useParams();
  const invitation = useQuery({
    queryKey: ['np', 'public-invitation', token],
    queryFn: () => lookupInvitation(api, token),
    retry: false,
  });

  let body: ReactNode;
  if (invitation.isPending) {
    body = (
      <p className='text-sm text-muted-foreground'>{t('np.invite.loading')}</p>
    );
  } else if (invitation.isError) {
    const key = errorKey(invitation.error);
    body = (
      <div className='space-y-5'>
        <FormStatus type='error'>{t(`np.invite.errors.${key}`)}</FormStatus>
        {key === 'accepted' ? <LoginLink /> : null}
      </div>
    );
  } else {
    body = <AcceptForm token={token} invitation={invitation.data} />;
  }

  return (
    <AuthLayout
      description={
        invitation.data
          ? invitation.data.projectNames.length
            ? t('np.invite.descriptionProjects', {
                inviter: invitation.data.inviterName,
                projects: invitation.data.projectNames.join('、'),
              })
            : t('np.invite.description', {
                inviter: invitation.data.inviterName,
              })
          : ''
      }
      form={body}
      logo={authLogo}
      marketing={authMarketing}
      title={t('np.invite.title')}
    />
  );
}

function AcceptForm({
  token,
  invitation,
}: {
  readonly token: string;
  readonly invitation: PublicInvitation;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const { session, client, refresh } = useAuthentication();
  const login = usePasswordLogin();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<'signedUp' | 'existing' | null>(null);

  async function signOut(): Promise<void> {
    // Better Auth returns API failures as data rather than throwing (see the account menu).
    const result = await client.signOut().catch(() => ({ error: true }));
    if (result.error) {
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.invite.signOutFailed'),
      });
      return;
    }
    await refresh();
  }

  // Once the new account's session arrives, go in.
  useEffect(() => {
    if (done === 'signedUp' && session) void navigate('/', { replace: true });
  }, [done, session, navigate]);

  if (session && done === null) {
    return (
      <div className='space-y-5'>
        <FormStatus type='success'>
          {t('np.invite.signedIn', {
            name: session.user.name || session.user.email,
          })}
        </FormStatus>
        <Button
          className='w-full'
          variant='outline'
          onClick={() => void signOut()}
        >
          {t('np.invite.signOut')}
        </Button>
      </div>
    );
  }

  if (done === 'existing') {
    return (
      <div className='space-y-5'>
        <FormStatus type='success'>{t('np.invite.existingAccount')}</FormStatus>
        <LoginLink />
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.trim()) {
      setProblem(t('np.invite.nameRequired'));
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setProblem(t('np.invite.passwordTooShort', { min: MIN_PASSWORD }));
      return;
    }
    setProblem(undefined);
    setSaving(true);
    try {
      const accepted = await acceptInvitation(api, {
        token,
        name: name.trim(),
        password,
      });
      if (accepted.existingAccount) {
        setDone('existing');
        return;
      }
      setDone('signedUp');
      await login.submit({ identifier: accepted.email, password });
    } catch (error: unknown) {
      setProblem(t(`np.invite.errors.${errorKey(error)}`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className='space-y-5' onSubmit={(event) => void submit(event)}>
      <div className='space-y-2'>
        <Label htmlFor='np-invite-email'>{t('np.invite.email')}</Label>
        <Input id='np-invite-email' value={invitation.email} readOnly />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='np-invite-name'>{t('np.invite.name')}</Label>
        <Input
          id='np-invite-name'
          autoComplete='name'
          autoFocus
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='np-invite-password'>{t('np.invite.password')}</Label>
        <Input
          id='np-invite-password'
          type='password'
          autoComplete='new-password'
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {problem ? <FormStatus type='error'>{problem}</FormStatus> : null}
      {done === 'signedUp' && login.error ? (
        <>
          <FormStatus type='error'>{login.error.message}</FormStatus>
          <LoginLink />
        </>
      ) : null}
      <Button
        className='w-full'
        disabled={saving || login.isPending || done === 'signedUp'}
        type='submit'
      >
        {saving || login.isPending
          ? t('np.invite.submitting')
          : t('np.invite.submit')}
      </Button>
    </form>
  );
}
