/**
 * NP-78 issue attachments: the file plugin's upload and content routes for the `npFiles` Collection, behind
 * NocoProject's own guards.
 *
 * - `POST /api/npFiles:uploadOne` (multipart, field `file`): stores one file on the configured disk
 *   (`nocoproject.attachmentDisk`, default `local`) and creates an unattached `npFiles` row whose `uploadedById` the
 *   upload Policy stamps from the session user. The body limit is `attachmentMaxFileSize` (default 20 MiB) plus the
 *   multipart overhead. No other repository action is exposed: listing, attaching and removing go through
 *   `/api/np/issues/:id/attachments` (`modules/attachment/`).
 * - `GET /uploads/np/<uuid>.<ext>`: streams the bytes as an attachment (`Cache-Control: private, no-store`,
 *   `nosniff`, `CSP sandbox`). NP-214: the safe raster images of `INLINE_PREVIEW_TYPES` (type and extension both
 *   matching) are served `inline` instead, so a browser shows them; everything else, SVG and HTML included, stays a
 *   download.
 * - NP-214 `agentUploadStore`: the agent API's uploads (`POST /api/np/agent/issues/:id/uploads`) through the same
 *   repository, stamped with the run instead of a user.
 *
 * The plugin's routes are public by design, so the guard contributions below are mounted first on the paths these
 * routes own (all contributions share one router, mounted in order; a guard never uses `use('*')`): the same guard as
 * the browser API for uploads (run tokens refused, session required, member bootstrapped) and, for content, a
 * session plus `AttachmentService.canRead` — the issue's visibility, or the uploader for an unattached file.
 * Anything the caller may not read is 404, like an invisible issue.
 *
 * The plugin routes are created per application (the disk and limits come from its configuration).
 */
import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import {
  defineFileRepositoryApiRoutes,
  serverFileRepositoryManagerToken,
} from '@nocobase/app-plugin-file/server';
import type { Application } from '@nocobase/app-server/application';
import {
  defineApiRoutes,
  defineRootRoutes,
  type AppRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type MiddlewareHandler } from 'hono';

import type { NocoProjectConfig } from '../config/nocoproject.js';
import type { AgentUploadStore } from '../modules/attachment/agent-upload.routes.js';
import {
  FILE_ACCESS_PATH,
  FILE_COLLECTION,
  fileIdOfContentName,
} from '../modules/attachment/attachment.records.js';
import { ensureMember } from '../modules/member/member.routes.js';
import {
  errorBody,
  rejectRunTokens,
  sessionActor,
} from '../modules/shared/http.js';
import { isInlinePreviewable } from '../modules/shared/protocol.js';
import {
  npAttachmentServiceToken,
  npMemberServiceToken,
} from '../providers/np.js';
import { npAccess } from '../providers/np-authorization.js';

export const FILE_RESOURCE = 'npFiles';
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;
/** Room for the multipart boundary and part headers around one file. */
const MULTIPART_OVERHEAD = 64 * 1024;

interface AttachmentSettings {
  readonly disk: string;
  readonly maxFileSize: number;
}

export function attachmentSettings(app: Application): AttachmentSettings {
  const config = app.config.get<NocoProjectConfig>('nocoproject');
  const size = config?.attachmentMaxFileSize;
  return {
    disk: config?.attachmentDisk || 'local',
    maxFileSize:
      Number.isSafeInteger(size) && (size as number) > 0
        ? (size as number)
        : DEFAULT_MAX_FILE_SIZE,
  };
}

type FileContributions = ReturnType<typeof defineFileRepositoryApiRoutes>;
const pluginRoutes = new WeakMap<Application, FileContributions>();

/** The plugin contributions for this application: `[api, root]`. */
function fileRoutesOf(app: Application): FileContributions {
  let routes = pluginRoutes.get(app);
  if (!routes) {
    const settings = attachmentSettings(app);
    routes = defineFileRepositoryApiRoutes<string>({
      // Behind the guard below, so there is always a session; the plugin answers 403 when there is none.
      principal: (context) =>
        (context.get('auth') as AuthEnv['Variables']['auth'])?.user
          .id as string,
      repositories: [
        {
          name: FILE_RESOURCE,
          collection: FILE_COLLECTION,
          disk: settings.disk,
          accessPath: FILE_ACCESS_PATH,
          accessMode: 'stream',
          policy: (userId) => ({
            read: false,
            // No `fields`: callers supply nothing; the upload stamps the uploader.
            create: { scope: true, defaults: { uploadedById: userId } },
            update: false,
            delete: false,
          }),
          actions: {
            uploadOne: { maxSize: settings.maxFileSize + MULTIPART_OVERHEAD },
          },
        },
      ],
    });
    pluginRoutes.set(app, routes);
  }
  return routes;
}

async function pluginRouter(app: Application, index: 0 | 1): Promise<Hono> {
  const contribution = fileRoutesOf(app)[index];
  if (!contribution) throw new Error('File plugin routes are missing.');
  return contribution.createRouter(app);
}

/**
 * NP-214: the agent API's uploads. The repository is the plugin's (storage, filename and type normalisation), under a
 * Policy that stamps the run rather than a user.
 */
export function agentUploadStore(app: Application): AgentUploadStore {
  const settings = attachmentSettings(app);
  return {
    maxFileSize: settings.maxFileSize,
    async upload(file, runId) {
      const files = app.container
        .resolve(serverFileRepositoryManagerToken)
        .repository(FILE_COLLECTION, {
          disk: settings.disk,
          accessPath: FILE_ACCESS_PATH,
          policy: {
            read: false,
            create: {
              scope: true,
              defaults: { uploadedById: null, uploadedByRunId: runId },
            },
            update: false,
            delete: false,
          },
        });
      const { record } = await files.uploadOne({ file });
      return {
        id: record.id,
        filename: record.filename,
        mimeType: record.mimeType,
        size: Number(record.size),
      };
    },
  };
}

/** The extension a content request names (`<uuid>.<ext>`); the plugin answers 404 when it is not the file's. */
function extOfContentName(name: string): string {
  const dot = name.indexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/** Content reads: 404 unless the session user may read the named file; safe raster images are served inline. */
function contentAccess(app: Application): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    const name = context.req.param('file') ?? '';
    const fileId = fileIdOfContentName(name);
    const attachments = app.container.resolve(npAttachmentServiceToken);
    if (
      !fileId ||
      !(await attachments.canRead(sessionActor(context), fileId))
    ) {
      return context.json(errorBody('NOT_FOUND', 'File not found.'), 404);
    }
    await next();
    const disposition = context.res.headers.get('content-disposition');
    if (
      context.res.status === 200 &&
      disposition?.startsWith('attachment;') &&
      isInlinePreviewable(
        context.res.headers.get('content-type') ?? '',
        extOfContentName(name),
      )
    )
      context.res.headers.set(
        'content-disposition',
        `inline${disposition.slice('attachment'.length)}`,
      );
  };
}

export const npFileRoutes: readonly AppRouteContribution<Application>[] = [
  // Guards first, on exactly the paths the plugin routes below own.
  defineApiRoutes((app) => {
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const members = app.container.resolve(npMemberServiceToken);
    const router = new Hono<AuthEnv>();
    router.use(
      `/${FILE_RESOURCE}:uploadOne`,
      rejectRunTokens(),
      auth.required(),
      // The same authorization context and `ActorAccess` as every browser prefix (NP-153).
      authz.middleware(),
      npAccess(authz),
      ensureMember(members),
    );
    return router as unknown as Hono;
  }),
  defineRootRoutes((app) => {
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const router = new Hono<AuthEnv>();
    router.use(
      `${FILE_ACCESS_PATH}/:file`,
      rejectRunTokens(),
      auth.required(),
      // `canRead` follows the caller's `issues/view` scope (NP-153).
      authz.middleware(),
      npAccess(authz),
      contentAccess(app),
    );
    return router as unknown as Hono;
  }),
  defineApiRoutes((app) => pluginRouter(app, 0)),
  defineRootRoutes((app) => pluginRouter(app, 1)),
];
