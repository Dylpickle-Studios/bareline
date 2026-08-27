import type { AppRouteContext } from './route-context.js';
import { isAddressAllowed } from '../../security/ip-policy.js';

function isTrustedMetricsRequest(context: AppRouteContext, requestIp: string): boolean {
  if (requestIp === '127.0.0.1' || requestIp === '::1') return true;
  return isAddressAllowed(
    requestIp,
    context.config.authentication?.reverseProxy?.allowedAddresses ?? [],
  );
}

export function registerHealthRoutes(context: AppRouteContext): void {
  const { app, database, git, metrics, search, isClosing } = context;

  app.get('/livez', async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });

  app.get('/readyz', async (_request, reply) => {
    let databaseReady = false;
    let gitReady = false;
    try {
      database.prepare('SELECT 1').get();
      databaseReady = true;
    } catch {
      databaseReady = false;
    }
    try {
      await git.run(['--version'], { timeoutMs: 2000, maxOutputBytes: 1024 });
      gitReady = true;
    } catch {
      gitReady = false;
    }
    let queue = { pending: 0, running: 0, failed: 0, documents: 0 };
    try {
      queue = search.status();
    } catch {
      databaseReady = false;
    }
    const saturation = Math.min(1, queue.pending / 1000);
    metrics.setGauge('storage_queue_saturation', saturation);
    const ready = !isClosing() && databaseReady && gitReady;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      checks: { database: databaseReady, git: gitReady },
      queue,
    });
  });

  app.get('/metrics', async (request, reply) => {
    if (!isTrustedMetricsRequest(context, request.ip)) {
      return reply.code(404).send();
    }
    return reply.type('text/plain; version=0.0.4').send(metrics.renderPrometheus());
  });

  app.get('/health', async (_request, reply) => {
    const gitVersion = await git.run(['--version'], { timeoutMs: 2000, maxOutputBytes: 1024 });
    metrics.increment('git_operations_total', { route: '/health', status: '200' });
    return reply.send({ status: 'ok', git: gitVersion.stdout.toString('utf8').trim() });
  });
}
