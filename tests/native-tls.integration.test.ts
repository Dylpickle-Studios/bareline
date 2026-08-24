import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { temporaryConfig } from './helpers.js';

describe('native TLS', () => {
  it('serves HTTPS with a configured certificate and TLS 1.2 minimum', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'focused-git-tls-'));
    const certificate = join(directory, 'certificate.pem');
    const privateKey = join(directory, 'private-key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=127.0.0.1',
        '-days',
        '1',
        '-keyout',
        privateKey,
        '-out',
        certificate,
      ],
      { stdio: 'ignore' },
    );
    const config = temporaryConfig();
    config.server.tls = { mode: 'native', certificate, privateKey };
    const app = await createApp(config);
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const status = await new Promise<number>((resolve, reject) => {
        get(address, { rejectUnauthorized: false, minVersion: 'TLSv1.2' }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }).on('error', reject);
      });
      expect(status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
