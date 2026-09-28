// NocoProject: a member's own preferences (NP-108).
//
// members: `inboxChime` — whether the browser chimes when the member's pending inbox decisions go up. On unless the
// member turns it off under 设置 → 通用 → 我的提醒; it follows the account, not the browser.
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const migration: MigrationDefinition = defineMigration({
  name: '2026100600001_np_member_preferences',

  async up({ builder }) {
    await builder.alterCollection('members', (table) => {
      table.boolean('inboxChime').notNull().defaultTo(true);
    });
  },

  async down({ builder }) {
    await builder.alterCollection('members', (table) => {
      table.dropFields('inboxChime');
    });
  },
});

export default migration;
