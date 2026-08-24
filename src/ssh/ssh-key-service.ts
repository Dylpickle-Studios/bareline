import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AuditService } from '../audit/audit-service.js';
import type { Database } from '../database/database.js';

export interface SshKeyView {
  id: number;
  name: string;
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export class SshKeyService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  async add(userId: number, nameInput: string, publicKeyInput: string): Promise<SshKeyView> {
    const name = nameInput.trim();
    if (name.length < 1 || name.length > 100) throw new SshKeyInputError('Key name is required');
    const publicKey = publicKeyInput.trim();
    if (publicKey.length > 16_384 || /[\r\n]/.test(publicKey) || publicKey.includes('\0')) {
      throw new SshKeyInputError('SSH key must be a single line');
    }
    if (
      !/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(publicKey)
    ) {
      throw new SshKeyInputError('Unsupported or malformed SSH public key');
    }
    const inspected = await inspectKey(publicKey);
    if (inspected.type === 'RSA' && inspected.bits < 3072) {
      throw new SshKeyInputError('RSA keys must contain at least 3072 bits');
    }
    const existing = this.database
      .prepare('SELECT id FROM ssh_keys WHERE fingerprint = ?')
      .get(inspected.fingerprint) as { id: number } | undefined;
    if (existing) throw new SshKeyInputError('This SSH key is already registered');
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `
        INSERT INTO ssh_keys(user_id, name, fingerprint, public_key, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(userId, name, inspected.fingerprint, publicKey, now);
    const id = Number(result.lastInsertRowid);
    this.audit.record({
      actorUserId: userId,
      action: 'sshKey.created',
      targetType: 'sshKey',
      targetId: String(id),
      metadata: { fingerprint: inspected.fingerprint },
    });
    return { id, name, fingerprint: inspected.fingerprint, createdAt: now, lastUsedAt: null };
  }

  list(userId: number): SshKeyView[] {
    const rows = this.database
      .prepare(
        `
        SELECT id, name, fingerprint, created_at, last_used_at
        FROM ssh_keys WHERE user_id = ? ORDER BY created_at DESC
      `,
      )
      .all(userId) as {
      id: number;
      name: string;
      fingerprint: string;
      created_at: string;
      last_used_at: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  remove(userId: number, keyId: number): void {
    const row = this.database
      .prepare('SELECT fingerprint FROM ssh_keys WHERE id = ? AND user_id = ?')
      .get(keyId, userId) as { fingerprint: string } | undefined;
    if (!row) throw new SshKeyInputError('SSH key not found');
    this.database.prepare('DELETE FROM ssh_keys WHERE id = ? AND user_id = ?').run(keyId, userId);
    this.audit.record({
      actorUserId: userId,
      action: 'sshKey.removed',
      targetType: 'sshKey',
      targetId: String(keyId),
      metadata: { fingerprint: row.fingerprint },
    });
  }
}

export async function inspectKey(
  publicKey: string,
): Promise<{ bits: number; fingerprint: string; type: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('ssh-keygen', ['-lf', '-', '-E', 'sha256'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new SshKeyInputError('SSH key could not be parsed'));
        return;
      }
      const line = Buffer.concat(output).toString('utf8').trim();
      const match = /^(\d+) (SHA256:[A-Za-z0-9+/]+)(?: .*)? \(([^)]+)\)$/.exec(line);
      if (!match?.[1] || !match[2] || !match[3]) {
        reject(new SshKeyInputError('SSH key inspection returned an invalid result'));
        return;
      }
      resolve({ bits: Number(match[1]), fingerprint: match[2], type: match[3] });
    });
    child.stdin.end(`${publicKey}\n`);
  });
}

export function fallbackFingerprint(publicKey: string): string {
  return `SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}`;
}

export class SshKeyInputError extends Error {
  readonly statusCode = 400;
}
