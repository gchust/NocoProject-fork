import { Hono } from 'hono';

import { errorBody, npErrorHandler } from '../shared/http.js';
import type { WebhookService } from './webhook.service.js';

/**
 * `POST /np/webhooks/github` (root route, contract §C).
 *
 * Deliberately public: GitHub cannot present a session or an API key. The security boundary is the
 * `X-Hub-Signature-256` HMAC over the raw body with the stored webhook secret (401 `INVALID_SIGNATURE` when it is
 * missing, wrong, or no secret is configured) plus replay protection by `X-GitHub-Delivery` (a duplicate is answered
 * 200 `{ duplicate: true }` and does nothing). The body is read as raw bytes before any parsing, so the signature
 * covers exactly what GitHub sent.
 */
export function createWebhookRoutes(webhooks: WebhookService): Hono {
  const routes = new Hono();
  routes.onError(npErrorHandler);
  routes.post('/np/webhooks/github', async (context) => {
    const body = new Uint8Array(await context.req.arrayBuffer());
    const result = await webhooks.receive({
      deliveryId: context.req.header('x-github-delivery') ?? null,
      event: context.req.header('x-github-event') ?? null,
      signature: context.req.header('x-hub-signature-256') ?? null,
      body,
    });
    switch (result.status) {
      case 'invalidSignature':
        return context.json(
          errorBody('INVALID_SIGNATURE', 'The webhook signature is not valid.'),
          401,
        );
      case 'missingDelivery':
        return context.json(
          errorBody('MISSING_DELIVERY', 'X-GitHub-Delivery is required.'),
          400,
        );
      case 'duplicate':
        return context.json({ data: { duplicate: true } });
      default:
        return context.json({
          data: { ok: true, event: result.event, ignored: result.ignored },
        });
    }
  });
  return routes;
}
