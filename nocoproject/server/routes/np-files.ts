/**
 * NP-78 issue attachments: the file plugin's upload and content routes for the `npFiles` Collection, behind
 * NocoProject's own guards.
 *
 * - `POST /api/npFiles:uploadOne` (multipart, field `file`): stores one file on the configured disk
 *   (`nocoproject.attachmentDisk`, default `local`) and creates an unattached `npFiles` row whose `uploadedById` the
 *   upload Policy stamps from the session user. The body limit is `attachmentMaxFileSize` (default 20 MiB) plus the
 *   multipart overhead. No other repository action is exposed: listing, attaching and removing go through
 *   `/api/np/issues/:id/attachments` (`modules/attachment/`).
 * - `GET /uploads/np/<uuid>.<ext>`: streams the bytes as an attachment (`Cache-Control: private, no-store`).
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
import { defineFileRepositoryApiRoutes } from '@nocobase/app-plugin-file/server';
import type { Application } from '@nocobase/app-server/application';
import {
  defineApiRoutes,
  defineRootRoutes,
  type AppRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type MiddlewareHandler } from 'hono';

import type { NocoProjectConfig } from '../config/nocoproject.js';
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
import {
  npAttachmentServiceToken,
  npMemberServiceToken,
} from '../providers/np.js';

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

/** Content reads: 404 unless the session user may read the named file. */
function contentAccess(app: Application): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    const fileId = fileIdOfContentName(context.req.param('file') ?? '');
    const attachments = app.container.resolve(npAttachmentServiceToken);
    if (
      !fileId ||
      !(await attachments.canRead(sessionActor(context), fileId))
    ) {
      return context.json(errorBody('NOT_FOUND', 'File not found.'), 404);
    }
    await next();
  };
}

export const npFileRoutes: readonly AppRouteContribution<Application>[] = [
  // Guards first, on exactly the paths the plugin routes below own.
  defineApiRoutes((app) => {
    const auth = app.container.resolve(authenticationToken);
    const members = app.container.resolve(npMemberServiceToken);
    const router = new Hono<AuthEnv>();
    router.use(
      `/${FILE_RESOURCE}:uploadOne`,
      rejectRunTokens(),
      auth.required(),
      ensureMember(members),
    );
    return router as unknown as Hono;
  }),
  defineRootRoutes((app) => {
    const auth = app.container.resolve(authenticationToken);
    const router = new Hono<AuthEnv>();
    router.use(
      `${FILE_ACCESS_PATH}/:file`,
      rejectRunTokens(),
      auth.required(),
      contentAccess(app),
    );
    return router as unknown as Hono;
  }),
  defineApiRoutes((app) => pluginRouter(app, 0)),
  defineRootRoutes((app) => pluginRouter(app, 1)),
];
