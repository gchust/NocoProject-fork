// NP-147: knowledge documents become a tree. knowledgeDocs gets parentId (nullable, another document in the same
// scope: same projectId including the system key '') and sortOrder (position among siblings). knowledgeProposals
// gets parentId too, so an accepted proposal can be filed under a specific parent (beyond the contract's list, like
// baseVersion: not surfaced through the protocol).
//
// Self-contained on purpose: every field and index is spelled out here and nothing is imported from server/modules,
// so the meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const ID = { length: 32 } as const;

const migration: MigrationDefinition = defineMigration({
  name: '2026100800001_np_knowledge_tree',

  async up({ builder }) {
    await builder.alterCollection('knowledgeDocs', (table) => {
      table.string('parentId', ID).nullable();
      table.integer('sortOrder').notNull().defaultTo(0);
      table.index(['projectId', 'parentId', 'sortOrder'], {
        name: 'np_knowledge_docs_parent_idx',
      });
    });
    await builder.alterCollection('knowledgeProposals', (table) => {
      table.string('parentId', ID).nullable();
    });
  },

  async down({ builder }) {
    // Two steps: within one alteration the column would go first, taking the index with it.
    await builder.alterCollection('knowledgeDocs', (table) => {
      table.dropIndex('np_knowledge_docs_parent_idx');
    });
    await builder.alterCollection('knowledgeDocs', (table) => {
      table.dropFields('parentId', 'sortOrder');
    });
    await builder.alterCollection('knowledgeProposals', (table) => {
      table.dropFields('parentId');
    });
  },
});

export default migration;
