import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { IssueQueries } from '../issue/issue.queries.js';
import type { RunTokenEnv } from '../run/agent-api.routes.js';
import { NpError } from '../shared/errors.js';
import { errorBody, npRouter } from '../shared/http.js';
import type { AgentUploadedFile } from '../shared/protocol.js';
import {
  ERROR_ATTACHMENT_TOO_LARGE,
  ERROR_INVALID_FILE,
  ERROR_UNSUPPORTED_MEDIA_TYPE,
} from '../shared/protocol.js';

/** Room for the multipart boundary and part headers around one file. */
const MULTIPART_OVERHEAD = 64 * 1024;

/** Stores an agent's upload as an unattached `npFiles` row stamped with the run; the route layer backs it with the file plugin. */
export interface AgentUploadStore {
  readonly maxFileSize: number;
  upload(file: File, runId: string): Promise<AgentUploadedFile>;
}

/**
 * NP-214 `POST /np/agent/issues/:id/uploads` (multipart, field `file`, one file of any type), behind the run-token
 * guard, which requires `attachment.upload`. Only the run's own issue (403 `ISSUE_NOT_IN_RUN`); larger than
 * `attachmentMaxFileSize` is 413 `ATTACHMENT_TOO_LARGE` (`details.maxFileSize`). Answers 201 with the unattached
 * upload, which a comment of the same run attaches with `attachmentIds`; unattached uploads are purged after a day.
 */
export function createAgentUploadRoutes(deps: {
  queries: IssueQueries;
  store: AgentUploadStore;
}): Hono<RunTokenEnv> {
  const { maxFileSize } = deps.store;
  const tooLarge = () =>
    errorBody(
      ERROR_ATTACHMENT_TOO_LARGE,
      `The file is larger than ${maxFileSize} bytes.`,
      { maxFileSize },
    );
  const routes = npRouter<RunTokenEnv>();
  routes.post(
    '/issues/:id/uploads',
    bodyLimit({
      maxSize: maxFileSize + MULTIPART_OVERHEAD,
      onError: (context) => context.json(tooLarge(), 413),
    }),
    async (context) => {
      const auth = context.get('runAuth');
      const issue = await deps.queries.forAgent(context.req.param('id'));
      if (issue.id !== auth.issueId)
        throw new NpError(
          'forbidden',
          'ISSUE_NOT_IN_RUN',
          'A run token may only write to its own issue.',
        );
      if (
        !context.req
          .header('content-type')
          ?.toLowerCase()
          .startsWith('multipart/form-data;')
      )
        return context.json(
          errorBody(
            ERROR_UNSUPPORTED_MEDIA_TYPE,
            'Expected multipart/form-data.',
          ),
          415,
        );
      let file: unknown;
      try {
        file = (await context.req.parseBody({ all: true })).file;
      } catch {
        return context.json(
          errorBody(ERROR_INVALID_FILE, 'Invalid multipart body.'),
          400,
        );
      }
      if (!(file instanceof File))
        return context.json(
          errorBody(ERROR_INVALID_FILE, 'Exactly one file is required.'),
          400,
        );
      if (file.size > maxFileSize) return context.json(tooLarge(), 413);
      return context.json(
        { data: await deps.store.upload(file, auth.runId) },
        201,
      );
    },
  );
  return routes;
}
