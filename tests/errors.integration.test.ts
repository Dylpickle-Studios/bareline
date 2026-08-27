import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { temporaryConfig } from './helpers.js';

describe('safe status-specific errors', () => {
  it('renders a non-disclosing HTML 404 with a request ID', async () => {
    const app = await createApp(temporaryConfig());
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/does-not-exist',
        headers: { 'x-request-id': 'attacker-controlled\r\nX-Injected: yes' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('Not found');
      expect(response.body).toContain('Request ID:');
      expect(response.body).not.toContain('/home/');
      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(response.headers['x-request-id']).not.toContain('attacker');
    } finally {
      await app.close();
    }
  });

  it('returns a consistent JSON error without internal exception details', async () => {
    const app = await createApp(temporaryConfig());
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/users/nobody' });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body) as {
        error: { code: string; message: string; requestId: string };
      };
      expect(body.error.code).toBe('forbidden');
      expect(body.error.message.length).toBeGreaterThan(0);
      expect(body.error.requestId.length).toBeGreaterThan(0);
      expect(response.body).not.toContain('AuthorizationError');
    } finally {
      await app.close();
    }
  });
});
