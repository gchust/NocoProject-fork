// @vitest-environment node
/**
 * NP-88 email invitations against a real PostgreSQL: who may invite into which projects, several addresses at once,
 * existing accounts added directly, a pending invitation merged and re-sent with a fresh link, a failed send
 * returning the link, revoke and expiry, and acceptance (account, workspace member, project members, one use only).
 * The mailer and the account creator are recording doubles; the whole-application path is `np-invitations-app`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { InvitationEmail } from '../../server/modules/member/invitation.mail.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  openNpTestDatabase,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_invitations');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-invitations] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

const APP = { appUrl: 'https://np.example.com/main/' };

let sent: InvitationEmail[] = [];
let failSend = false;
let services: NpServices;
let created = 0;

function tokenOf(url: string): string {
  return url.split('/invite/')[1] ?? '';
}

function lastToken(): string {
  const email = sent.at(-1);
  const match = /\/invite\/([A-Za-z0-9_-]+)/u.exec(email?.text ?? '');
  return match?.[1] ?? '';
}

async function project(owner: Actor, name: string): Promise<string> {
  return (await services.projects.create(owner, { name })).id;
}

async function projectMemberIds(projectId: string): Promise<string[]> {
  return (
    await rows(db!, 'project_members', 'project_id = ?', [projectId])
  ).map((row) => String(row.user_id));
}

describe.skipIf(!db)('NocoProject email invitations (PostgreSQL)', () => {
  beforeEach(async () => {
    await resetData(db!);
    await db!.knex.raw(
      `DELETE FROM "${db!.schema}"."user" WHERE id NOT IN ('u-alice', 'u-bob', 'u-carol')`,
    );
    sent = [];
    failSend = false;
    services = buildServices(db!.database, {
      mailer: () => ({
        send: async (email) => {
          if (failSend) throw new Error('SMTP refused');
          sent.push(email);
        },
      }),
      accounts: () => ({
        create: async (conn, input) => {
          created += 1;
          const id = `u-new-${created}`;
          await conn.query
            .insertInto('user')
            .values({ id, name: input.name, email: input.email })
            .execute();
          return id;
        },
      }),
    }).services;
    await setRole(db!, ALICE, 'owner');
    await setRole(db!, BOB, 'member');
    await setRole(db!, CAROL, 'member');
  });

  it('invites several addresses into several projects and adds existing accounts directly', async () => {
    const web = await project(ALICE, 'Web');
    const api = await project(ALICE, 'Api');
    const { results } = await services.invitations.create(
      ALICE,
      {
        emails: [' New1@Example.com ', 'new2@example.com', 'bob@example.com'],
        projectIds: [web, api],
      },
      APP,
    );
    expect(results).toEqual([
      { email: 'new1@example.com', outcome: 'invited', emailSent: true },
      { email: 'new2@example.com', outcome: 'invited', emailSent: true },
      { email: 'bob@example.com', outcome: 'added' },
    ]);
    expect(sent.map((email) => email.to)).toEqual([
      'new1@example.com',
      'new2@example.com',
    ]);
    expect(sent[0]!.subject).toContain('Alice');
    expect(sent[0]!.text).toContain('Web');
    expect(sent[0]!.text).toContain('https://np.example.com/main/invite/');
    expect(await projectMemberIds(web)).toContain(BOB.id);
    expect(await projectMemberIds(api)).toContain(BOB.id);

    const again = await services.invitations.create(
      ALICE,
      { emails: ['bob@example.com'], projectIds: [web] },
      APP,
    );
    expect(again.results).toEqual([
      { email: 'bob@example.com', outcome: 'alreadyMember' },
    ]);

    const list = await services.invitations.list(ALICE);
    expect(list.map((item) => item.email).sort()).toEqual([
      'new1@example.com',
      'new2@example.com',
    ]);
    expect(list[0]).toMatchObject({
      status: 'pending',
      invitedBy: { userId: ALICE.id, name: 'Alice' },
    });
    expect(list[0]!.projects.map((item) => item.name).sort()).toEqual([
      'Api',
      'Web',
    ]);
    const stored = await rows(db!, 'np_invitations');
    expect(stored.every((row) => String(row.token_hash).length === 64)).toBe(
      true,
    );
    expect(JSON.stringify(stored)).not.toContain(lastToken());
  });

  it('validates the addresses and the projects', async () => {
    await expect(
      services.invitations.create(ALICE, { emails: [] }, APP),
    ).rejects.toMatchObject({ code: 'INVALID_EMAILS' });
    await expect(
      services.invitations.create(ALICE, { emails: ['not-an-email'] }, APP),
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(
      services.invitations.create(
        ALICE,
        { emails: ['x@example.com'], projectIds: ['missing'] },
        APP,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
  });

  it('lets a project lead invite only into projects they lead', async () => {
    const mine = await project(BOB, 'Bob project');
    const other = await project(ALICE, 'Alice project');
    await expect(
      services.invitations.create(BOB, { emails: ['x@example.com'] }, APP),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.invitations.create(
        BOB,
        { emails: ['x@example.com'], projectIds: [mine, other] },
        APP,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { results } = await services.invitations.create(
      BOB,
      { emails: ['x@example.com'], projectIds: [mine] },
      APP,
    );
    expect(results[0]).toMatchObject({ outcome: 'invited' });
    // A plain member leads nothing.
    await expect(
      services.invitations.create(
        CAROL,
        { emails: ['y@example.com'], projectIds: [mine] },
        APP,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Leads see and manage their own invitations; owner/admin see all.
    expect(await services.invitations.list(CAROL)).toEqual([]);
    expect(await services.invitations.list(BOB)).toHaveLength(1);
    const [invitation] = await services.invitations.list(ALICE);
    await expect(
      services.invitations.revoke(CAROL, invitation!.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('merges a second invitation for the same address and re-sends with a fresh link', async () => {
    const web = await project(ALICE, 'Web');
    const api = await project(ALICE, 'Api');
    await services.invitations.create(
      ALICE,
      { emails: ['new@example.com'], projectIds: [web] },
      APP,
    );
    const first = lastToken();
    await services.invitations.create(
      ALICE,
      { emails: ['new@example.com'], projectIds: [api] },
      APP,
    );
    const second = lastToken();
    expect(second).not.toBe(first);
    const list = await services.invitations.list(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0]!.projects.map((item) => item.id).sort()).toEqual(
      [web, api].sort(),
    );
    await expect(services.invitations.lookup(first)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(services.invitations.lookup(second)).resolves.toMatchObject({
      email: 'new@example.com',
      inviterName: 'Alice',
    });

    const resent = await services.invitations.resend(ALICE, list[0]!.id, APP);
    expect(resent).toMatchObject({ outcome: 'invited', emailSent: true });
    await expect(services.invitations.lookup(second)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      services.invitations.lookup(lastToken()),
    ).resolves.toBeDefined();
  });

  it('returns the link once when the email cannot be sent', async () => {
    failSend = true;
    const { results } = await services.invitations.create(
      ALICE,
      { emails: ['new@example.com'] },
      APP,
    );
    expect(results[0]).toMatchObject({
      outcome: 'invited',
      emailSent: false,
    });
    const url = results[0]!.inviteUrl!;
    expect(url).toMatch(/^https:\/\/np\.example\.com\/main\/invite\//u);
    await expect(
      services.invitations.lookup(tokenOf(url)),
    ).resolves.toMatchObject({ email: 'new@example.com' });
    const [row] = await rows(db!, 'np_invitations');
    expect(row).toMatchObject({ sent_at: null, send_error: 'SMTP refused' });
    const [listed] = await services.invitations.list(ALICE);
    expect(listed!.sentAt).toBeNull();
  });

  it('accepts once: creates the account, the workspace member and the project memberships', async () => {
    const web = await project(ALICE, 'Web');
    const gone = await project(ALICE, 'Gone');
    await services.invitations.create(
      ALICE,
      { emails: ['new@example.com'], projectIds: [web, gone] },
      APP,
    );
    const token = lastToken();
    await services.projects.remove(ALICE, gone);
    await expect(
      services.invitations.accept(token, { name: 'New', password: 'short' }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    await expect(
      services.invitations.accept(token, {
        name: ' ',
        password: 'long-enough',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME' });

    const accepted = await services.invitations.accept(token, {
      name: 'New Person',
      password: 'long-enough-1',
    });
    expect(accepted).toEqual({
      email: 'new@example.com',
      existingAccount: false,
    });
    const [user] = await rows(db!, 'user', 'email = ?', ['new@example.com']);
    expect(user).toMatchObject({ name: 'New Person' });
    const userId = String(user!.id);
    expect(await rows(db!, 'members', 'user_id = ?', [userId])).toEqual([
      expect.objectContaining({ role: 'member' }),
    ]);
    expect(await rows(db!, 'project_members', 'user_id = ?', [userId])).toEqual(
      [expect.objectContaining({ project_id: web, role: 'member' })],
    );
    const [row] = await rows(db!, 'np_invitations');
    expect(row).toMatchObject({ status: 'accepted', accepted_user_id: userId });

    await expect(
      services.invitations.accept(token, {
        name: 'Again',
        password: 'long-enough-1',
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_ACCEPTED' });
    await expect(services.invitations.lookup(token)).rejects.toMatchObject({
      code: 'INVITATION_ACCEPTED',
    });
    expect(await services.invitations.list(ALICE)).toEqual([]);
  });

  it('joins the projects without a new account when the address registered meanwhile', async () => {
    const web = await project(ALICE, 'Web');
    await services.invitations.create(
      ALICE,
      { emails: ['late@example.com'], projectIds: [web] },
      APP,
    );
    await db!.knex.raw(
      `INSERT INTO "${db!.schema}"."user" (id, name, email) VALUES ('u-late', 'Late', 'late@example.com')`,
    );
    const before = created;
    await expect(
      services.invitations.accept(lastToken(), {
        name: 'Late',
        password: 'long-enough-1',
      }),
    ).resolves.toEqual({ email: 'late@example.com', existingAccount: true });
    expect(created).toBe(before);
    expect(await projectMemberIds(web)).toContain('u-late');
  });

  it('refuses revoked and expired invitations', async () => {
    await services.invitations.create(
      ALICE,
      { emails: ['a@example.com', 'b@example.com'] },
      APP,
    );
    const [first, second] = sent.map(
      (email) => /\/invite\/([A-Za-z0-9_-]+)/u.exec(email.text)![1]!,
    );
    const list = await services.invitations.list(ALICE);
    const a = list.find((item) => item.email === 'a@example.com')!;
    await services.invitations.revoke(ALICE, a.id);
    await expect(services.invitations.lookup(first!)).rejects.toMatchObject({
      code: 'INVITATION_REVOKED',
    });
    await expect(
      services.invitations.revoke(ALICE, a.id),
    ).rejects.toMatchObject({ code: 'INVITATION_CLOSED' });

    await db!.knex.raw(
      `UPDATE "${db!.schema}".np_invitations SET expires_at = now() - interval '1 minute' WHERE email = 'b@example.com'`,
    );
    await expect(services.invitations.lookup(second!)).rejects.toMatchObject({
      code: 'INVITATION_EXPIRED',
    });
    await expect(
      services.invitations.accept(second!, {
        name: 'B',
        password: 'long-enough-1',
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    const [expired] = await services.invitations.list(ALICE);
    expect(expired).toMatchObject({
      email: 'b@example.com',
      status: 'expired',
    });
    await expect(services.invitations.lookup('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
