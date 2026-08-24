import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { SshKeyService } from '../src/ssh/ssh-key-service.js';
import { temporaryConfig } from './helpers.js';

describe('SSH key management', () => {
  it('validates through ssh-keygen, deduplicates, and audits removal', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const directory = mkdtempSync(join(tmpdir(), 'focused-git-ssh-key-'));
    const privateKey = join(directory, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey]);
    const publicKey = readFileSync(`${privateKey}.pub`, 'utf8');
    const service = new SshKeyService(database, audit);
    const key = await service.add(user.id, 'Laptop', publicKey);
    expect(key.fingerprint).toMatch(/^SHA256:/);
    await expect(service.add(user.id, 'Duplicate', publicKey)).rejects.toThrow(
      /already registered/,
    );
    service.remove(user.id, key.id);
    expect(service.list(user.id)).toEqual([]);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE action LIKE 'sshKey.%'")
        .get(),
    ).toEqual({ count: 2 });
    database.close();
  });

  it('rejects command-like and multiline key input before invoking tools', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const service = new SshKeyService(database, new AuditService(database));
    await expect(service.add(1, 'bad', 'ssh-ed25519 AAAA\ncommand="id"')).rejects.toThrow(
      /single line/,
    );
    database.close();
  });
});
