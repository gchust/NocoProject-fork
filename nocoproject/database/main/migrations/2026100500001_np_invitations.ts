// NocoProject email invitations (NP-88, docs/phase2/invitations.md).
//
// npInvitations: one row per invited email address. Only the SHA-256 of the invitation token is stored (the token
// itself is in the email link); `projectIds` is a JSON array of the projects the invitee joins as a member on
// acceptance. `status` is pending | accepted | revoked (expiry is read from `expiresAt`). `sentAt` / `sendError`
// record the last delivery attempt.
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const ID = { length: 32 } as const;
const USER_ID = { length: 64 } as const;

const migration: MigrationDefinition = defineMigration({
  name: '2026100500001_np_invitations',

  async up({ builder }) {
    await builder.createCollection('npInvitations', (table) => {
      table.string('id', ID).primary();
      table.string('email', { length: 255 }).notNull();
      table.string('tokenHash', { length: 64 }).notNull();
      table.text('projectIds').notNull();
      table.string('status', { length: 16 }).notNull();
      table.string('invitedById', USER_ID).notNull();
      table.datetimeTz('expiresAt').notNull();
      table.datetimeTz('sentAt').nullable();
      table.text('sendError').nullable();
      table.string('acceptedUserId', USER_ID).nullable();
      table.datetimeTz('acceptedAt').nullable();
      table.datetimeTz('createdAt').notNull();
      table.datetimeTz('updatedAt').notNull();
      table.unique('tokenHash', { name: 'np_invitations_token_unique' });
      table.index(['email', 'status'], { name: 'np_invitations_email_idx' });
    });
  },

  async down({ builder }) {
    await builder.dropCollection('npInvitations');
  },
});

export default migration;
