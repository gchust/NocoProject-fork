import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { Link, useParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpDetailSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { RouteChildPage } from '@/components/route-child-page';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

import {
  fetchAccessCatalog,
  fetchBusinessRoles,
  updateBusinessRole,
} from '../api-roles.js';
import { npKeys } from '../constants.js';
import type { AccessCatalog, BusinessRole } from '../types-roles.js';
import { settingsCheck } from './config-access.js';
import { RoleEditor } from './role-editor.js';
import {
  draftFromGrants,
  grantsFromDraft,
  roleErrorKey,
  roleTitle,
  type RoleDraft,
} from './roles-model.js';

function RoleBody({
  role,
  catalog,
  canDefine,
}: {
  readonly role: BusinessRole;
  readonly catalog: AccessCatalog;
  readonly canDefine: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RoleDraft>(() =>
    draftFromGrants(catalog, role.grants),
  );
  const [title, setTitle] = useState(() => roleTitle(t, role));
  const [dirty, setDirty] = useState(false);
  const readOnly = !canDefine || !role.editable;
  const save = useMutation({
    mutationFn: () =>
      updateBusinessRole(api, role.key, {
        // Built-in roles keep their translated title; only custom roles are renamed here.
        ...(role.builtIn ? {} : { title }),
        grants: grantsFromDraft(catalog, draft),
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: t('np.roles.saved', { name: title.trim() }),
      });
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: npKeys.accessRoles });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t(
          error instanceof ApiClientError
            ? roleErrorKey(error.code, error.status)
            : 'np.common.requestFailed',
        ),
      }),
  });

  const kind = role.builtIn ? (
    <NpTag tone='blue'>{t('np.roles.builtIn')}</NpTag>
  ) : (
    <NpTag tone='grey'>{t('np.roles.custom')}</NpTag>
  );
  return (
    <>
      <PageHeader
        title={
          <span className='inline-flex flex-wrap items-center gap-3'>
            {roleTitle(t, role)}
            {kind}
          </span>
        }
        description={t('np.roles.holders', { count: role.holderCount })}
        actions={
          readOnly ? undefined : (
            <>
              <Button
                variant='outline'
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setDraft(draftFromGrants(catalog, role.grants));
                  setTitle(roleTitle(t, role));
                  setDirty(false);
                }}
              >
                {t('np.roles.discard')}
              </Button>
              <Button
                disabled={!dirty || !title.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {t('np.roles.save')}
              </Button>
            </>
          )
        }
      />
      {!role.editable ? (
        <Alert>
          <AlertDescription>{t('np.roles.ownerReadOnly')}</AlertDescription>
        </Alert>
      ) : null}
      {role.hasForeignGrants ? (
        <Alert>
          <AlertDescription>{t('np.roles.platformHint')}</AlertDescription>
        </Alert>
      ) : null}
      {!role.builtIn && !readOnly ? (
        <Field className='max-w-md'>
          <FieldLabel htmlFor='np-role-title'>{t('np.roles.name')}</FieldLabel>
          <Input
            id='np-role-title'
            value={title}
            maxLength={100}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
          />
        </Field>
      ) : null}
      <RoleEditor
        catalog={catalog}
        draft={draft}
        readOnly={readOnly}
        onChange={(next) => {
          setDraft(next);
          setDirty(true);
        }}
      />
    </>
  );
}

/**
 * Route `/config/members/roles/:roleKey` (NP-153): one business role as a covering page — its pages, settings actions
 * and business actions with their data scope (`RoleEditor`), saved through `PUT /np/access/roles/:key` by whoever
 * holds `nocoproject.members` `define-roles`; everyone else who may read the member settings sees it read-only.
 * `np-owner` holds everything and is shown read-only; platform grants of the set are kept by the server.
 */
export default function RoleDetailPage(): ReactElement {
  const { roleKey = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const roles = useQuery({
    queryKey: npKeys.accessRoles,
    queryFn: ({ signal }) => fetchBusinessRoles(api, signal),
  });
  const catalog = useQuery({
    queryKey: npKeys.accessCatalog,
    queryFn: ({ signal }) => fetchAccessCatalog(api, signal),
    staleTime: Infinity,
  });
  const canDefine = useCan(settingsCheck('members', 'define-roles'));
  const role = roles.data?.find((item) => item.key === roleKey);
  const back = (
    <Button
      variant='outline'
      size='sm'
      nativeButton={false}
      render={<Link to='../..?tab=roles' relative='path' />}
    >
      {t('np.roles.backToList')}
    </Button>
  );

  let body: ReactElement;
  const failed = roles.isError ? roles : catalog.isError ? catalog : null;
  if (failed) {
    body = (
      <NpLoadError
        title={t('np.roles.loadFailed')}
        error={failed.error}
        action={back}
      />
    );
  } else if (!roles.data || !catalog.data || canDefine.isPending) {
    body = <NpDetailSkeleton />;
  } else if (!role) {
    body = (
      <Alert>
        <AlertTitle>{t('np.roles.notFound')}</AlertTitle>
        <AlertAction>{back}</AlertAction>
      </Alert>
    );
  } else {
    body = (
      <RoleBody
        key={`${role.key}:${JSON.stringify(role.grants)}`}
        role={role}
        catalog={catalog.data}
        canDefine={canDefine.can}
      />
    );
  }

  return (
    <RouteChildPage>
      <PageContainer>
        <Breadcrumbs />
        {body}
      </PageContainer>
    </RouteChildPage>
  );
}
