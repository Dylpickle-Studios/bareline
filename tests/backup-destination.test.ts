import { createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupDestinationService } from '../src/backup/backup-destination-service.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('off-site backup encryption', () => {
  it('writes a versioned authenticated envelope that does not contain plaintext', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bareline-backup-envelope-'));
    const source = join(directory, 'backup.tar');
    const destination = join(directory, 'backup.enc');
    const plaintext = Buffer.from('private repository backup contents');
    const key = randomBytes(32);
    writeFileSync(source, plaintext);
    await BackupDestinationService.encryptFile(source, destination, key.toString('base64url'));
    const encrypted = readFileSync(destination);
    expect(encrypted.includes(plaintext)).toBe(false);
    expect(encrypted.subarray(0, 16).toString('ascii')).toBe('BARELINE-BACKUP\0');
    expect(encrypted[16]).toBe(1);
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(17, 29));
    decipher.setAuthTag(encrypted.subarray(-16));
    expect(Buffer.concat([decipher.update(encrypted.subarray(29, -16)), decipher.final()])).toEqual(
      plaintext,
    );
  });

  it('rejects an upload larger than the configured bound before resolving its endpoint', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    config.limits.archiveBytes = 4;
    const database = openDatabase(config.database.path);
    const user = await new AuthService(database, config, new AuditService(database)).register({
      username: 'backup-admin',
      displayName: 'Backup Admin',
      password: 'correct horse battery staple',
    });
    const service = new BackupDestinationService(database, config, {
      resolveEndpoint: () =>
        Promise.reject(new Error('endpoint resolution should not run for an oversized file')),
    });
    service.save(user.id, {
      name: 'offsite',
      endpoint: 'https://backup.example.com',
      region: 'eu-west-1',
      bucket: 'bareline',
      prefix: '',
      accessKey: 'access',
      secretKey: 'secret',
    });
    const source = join(mkdtempSync(join(tmpdir(), 'bareline-upload-bound-')), 'backup.tar');
    writeFileSync(source, '12345');

    await expect(service.upload(1, source, 'backup.tar')).rejects.toThrow(/maximum size/);
    database.close();
  });

  it('rejects private, local, and non-default-port endpoints', () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const service = new BackupDestinationService(database, config);
    const input = {
      name: 'offsite',
      region: 'eu-west-1',
      bucket: 'bareline',
      prefix: '',
      accessKey: 'access',
      secretKey: 'secret',
    };
    expect(() => {
      service.save(1, { ...input, endpoint: 'https://127.0.0.1' });
    }).toThrow(/public/);
    expect(() => {
      service.save(1, { ...input, endpoint: 'https://localhost' });
    }).toThrow(/public/);
    expect(() => {
      service.save(1, { ...input, endpoint: 'https://[::1]' });
    }).toThrow(/public/);
    expect(() => {
      service.save(1, { ...input, endpoint: 'https://backup.example.com:8443' });
    }).toThrow(/public/);
    database.close();
  });

  it('runs the explicit endpoint policy hook before making an upload request', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const user = await new AuthService(database, config, new AuditService(database)).register({
      username: 'policy-admin',
      displayName: 'Policy Admin',
      password: 'correct horse battery staple',
    });
    let checked = false;
    const service = new BackupDestinationService(database, config, {
      validateEndpoint: () => {
        checked = true;
        throw new Error('endpoint is not in the deployment allowlist');
      },
      resolveEndpoint: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    });
    service.save(user.id, {
      name: 'offsite',
      endpoint: 'https://backup.example.com',
      region: 'eu-west-1',
      bucket: 'bareline',
      prefix: '',
      accessKey: 'access',
      secretKey: 'secret',
    });
    const source = join(mkdtempSync(join(tmpdir(), 'bareline-upload-policy-')), 'backup.tar');
    writeFileSync(source, 'backup');

    await expect(service.upload(1, source, 'backup.tar')).rejects.toThrow(
      /Encrypted backup upload failed/,
    );
    expect(checked).toBe(true);
    database.close();
  });
});
