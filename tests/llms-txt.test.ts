import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { temporaryConfig } from './helpers.js';

describe('llms.txt', () => {
  it('serves a plain-text feature summary for LLM tooling', async () => {
    const config = temporaryConfig();
    const app = await createApp(config);
    try {
      const response = await app.inject({ method: 'GET', url: '/llms.txt' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('# Bareline');
      expect(response.body).toContain('/:owner/:repo/patches');
      expect(response.body).toContain('/:owner/:repo/fork');
      expect(response.body).toContain('/:owner/:repo/wiki');
      expect(response.body).toContain('/:owner/:repo/releases');
      expect(response.body).toContain('/:owner/:repo/insights');
      expect(response.body).toContain(`${config.server.publicUrl}/docs/api`);
    } finally {
      await app.close();
    }
  });
});
