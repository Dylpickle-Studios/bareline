import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { temporaryConfig } from './helpers.js';

describe('health and observability routes', () => {
  it('keeps liveness independent from readiness and exposes trusted metrics', async () => {
    const app = await createApp(temporaryConfig());
    try {
      const live = await app.inject({ method: 'GET', url: '/livez' });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: 'ok' });

      const ready = await app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        status: 'ok',
        checks: { database: true, git: true },
      });

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: 'ok' });

      const metrics = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.headers['content-type']).toContain('text/plain');
      expect(metrics.body).toContain('bareline_http_requests_total');
      expect(metrics.body).toContain('bareline_git_operations_total');
      expect(metrics.body).toContain('bareline_storage_queue_saturation');
      expect(metrics.body).not.toContain('authorization');
    } finally {
      await app.close();
    }
  });
});
