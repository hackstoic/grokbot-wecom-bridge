import { WeComBridgeDO } from './bridge-do';
import type { Env } from './types';

export { WeComBridgeDO };

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function checkApiKey(request: Request, env: Env): boolean {
  const key = (env.API_KEY || '').trim();
  if (!key) return false;
  const auth = request.headers.get('Authorization') || '';
  // Accept "Bearer <API_KEY>" or raw API_KEY in Authorization
  if (auth === `Bearer ${key}` || auth === key) return true;
  // Also accept X-Api-Key
  if ((request.headers.get('X-Api-Key') || '') === key) return true;
  return false;
}

/** Single Durable Object per Worker deployment (one bot per deploy / env). */
function bridgeStub(env: Env): DurableObjectStub {
  return env.BRIDGE.get(env.BRIDGE.idFromName('default'));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health can be probed with API key (same as other routes) —
    // keeps the surface consistent with a public Worker URL.
    if (path === '/health' || path === '/reply' || path === '/send' || path === '/send-media') {
      if (!checkApiKey(request, env)) return unauthorized();
      // Ensure DO is awake before serving API (especially after cold start)
      if (path !== '/health') {
        // no-op ensure on mutating routes happens inside DO as needed
      }
      return bridgeStub(env).fetch(
        new Request(new URL(path, 'https://do.internal'), {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        }),
      );
    }

    if (path === '/' || path === '') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'grokbot-wecom-bridge',
          endpoints: ['/health', '/reply', '/send', '/send-media'],
        }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Periodically wake the DO so outbound WS can be re-established after eviction/deploy.
    ctx.waitUntil(
      bridgeStub(env)
        .fetch(new Request('https://do.internal/internal/ensure', { method: 'POST' }))
        .then(async (r) => {
          console.log('cron ensure', r.status, await r.text());
        })
        .catch((e) => console.error('cron ensure failed', e)),
    );
  },
} satisfies ExportedHandler<Env>;
