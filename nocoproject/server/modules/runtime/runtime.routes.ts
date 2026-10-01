import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, queryText, readJson, sessionActor } from '../shared/http.js';
import type {
  EnableBuiltinRuntimeRequest,
  UpdateRuntimeRequestV2,
} from '../shared/protocol.js';
import { runtimeTypeFilter } from '../shared/runtime-types.js';
import type { BuiltinCheck } from './builtin-runtime.js';
import type { RuntimeService } from './runtime.service.js';

/** A connectivity check's answer: the runtime, and why the check failed (`details.message`) when it did. */
function checkBody(result: BuiltinCheck) {
  return result.message === null
    ? { data: result.runtime }
    : { data: result.runtime, details: { message: result.message } };
}

/**
 * `/np/runtimes` (browser): list (`?runtimeType=`), and `PATCH /:id { visibility }` by the runtime owner; NP-183
 * `{ pmAllowed }` by an owner / admin. NP-219 (protocol-runtime-types.md §5): built-in runtimes — the candidate LLM
 * services, enable, connectivity check, rename (`PATCH { name }`) and delete — by an owner / admin.
 */
export function createRuntimeRoutes(runtimes: RuntimeService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({
      data: await runtimes.list(
        runtimeTypeFilter(queryText(context, 'runtimeType')),
      ),
    }),
  );
  routes.get('/builtin/candidates', async (context) =>
    context.json({
      data: await runtimes.builtinCandidates(sessionActor(context)),
    }),
  );
  routes.post('/builtin', async (context) => {
    const body = await readJson<EnableBuiltinRuntimeRequest>(context);
    return context.json(
      checkBody(await runtimes.enableBuiltin(sessionActor(context), body)),
      201,
    );
  });
  routes.post('/:id/check', async (context) =>
    context.json(
      checkBody(
        await runtimes.checkBuiltin(
          sessionActor(context),
          context.req.param('id'),
        ),
      ),
    ),
  );
  routes.delete('/:id', async (context) => {
    await runtimes.remove(sessionActor(context), context.req.param('id'));
    return context.json({ data: { ok: true } });
  });
  routes.patch('/:id', async (context) => {
    const body = await readJson<
      Omit<UpdateRuntimeRequestV2, 'pmAllowed' | 'name'> & {
        readonly pmAllowed?: unknown;
        readonly name?: unknown;
      }
    >(context);
    const actor = sessionActor(context);
    const id = context.req.param('id');
    let data = null;
    if (body.name !== undefined)
      data = await runtimes.rename(actor, id, body.name);
    if (
      body.visibility !== undefined ||
      (body.pmAllowed === undefined && body.name === undefined)
    )
      data = await runtimes.setVisibility(actor, id, body.visibility);
    if (body.pmAllowed !== undefined)
      data = await runtimes.setPmAllowed(actor, id, body.pmAllowed);
    return context.json({ data });
  });
  return routes;
}
