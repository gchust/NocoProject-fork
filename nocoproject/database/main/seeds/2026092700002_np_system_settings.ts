import { defineSeed, type SeedDefinition } from '@nocobase/db';

// The single systemSettings row the issue service allocates issue numbers from. Idempotent: an existing row keeps
// its counter and its (possibly edited) prefix, so a repeat run changes nothing.
const seed: SeedDefinition = defineSeed({
  name: '2026092700002_np_system_settings',

  async run(context) {
    const settings = context.repository('systemSettings');
    const existing = await settings.findOne({ filter: { id: 'default' } });
    if (existing) return;
    await settings.createOne({
      values: { id: 'default', issuePrefix: 'NP', issueCounter: 0 },
    });
  },
});

export default seed;
