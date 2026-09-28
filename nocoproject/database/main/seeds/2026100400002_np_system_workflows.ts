import { defineSeed, type SeedDefinition } from '@nocobase/db';

// NP-77 stage 2 (方案 §4): the seeded templates `default` and `software-with-approval` are system templates. Agents
// may only copy them (`copyFrom`), so the seeds' idempotent patches never collide with edits. Idempotent: setting the
// flag again changes nothing; a missing row is skipped.
//
// Self-contained on purpose: the ids are spelled out here rather than imported from server/modules.
const SYSTEM_TEMPLATE_IDS = ['default', 'software-with-approval'];

const seed: SeedDefinition = defineSeed({
  name: '2026100400002_np_system_workflows',

  async run({ query }) {
    await query
      .updateTable('workflowTemplates')
      .set({ isSystem: true })
      .where('id', 'in', SYSTEM_TEMPLATE_IDS)
      .execute();
  },
});

export default seed;
