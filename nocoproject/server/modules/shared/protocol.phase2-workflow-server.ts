/**
 * NocoProject protocol types: Phase 2 workflow stage actions server-only additional shapes
 * (docs/phase2/protocol-workflow-stage-actions.md).
 *
 * Composes the server-only types from iteration 4; not copied by the CLI. The contract types are in
 * protocol.phase2-workflow.ts.
 */
import type { IssueDetailV4Paged } from './protocol.phase1-iter4-server.js';
import type { ExecutorProposalV5 } from './protocol.phase2-workflow.js';

/** `GET /np/issues/:id`: `proposals` carries `source`, `stageStatusKey`; a workflow proposal has no proposing agent */
export type IssueDetailV5Paged = Omit<IssueDetailV4Paged, 'proposals'> & {
  readonly proposals: readonly ExecutorProposalV5[];
};
