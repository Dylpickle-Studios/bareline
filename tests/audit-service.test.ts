import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('audit export and checkpoints', () => {
  it('exports a deterministic hash chain and verifies a signed checkpoint', () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    audit.record({ action: 'repository.created', targetType: 'repository', targetId: '1' });
    audit.record({
      action: 'repository.visibilityChanged',
      targetType: 'repository',
      targetId: '1',
      metadata: { visibility: 'private' },
    });

    const lines = audit
      .exportJsonLines()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown) as {
      id: number;
      chainHash: string;
    }[];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.chainHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lines[1]?.chainHash).not.toBe(lines[0]?.chainHash);

    const key = randomBytes(32).toString('base64url');
    const checkpoint = audit.createCheckpoint(key);
    expect(checkpoint).toMatchObject({ eventCount: 2, lastEventId: 2 });
    audit.record({ action: 'repository.pushed', targetType: 'repository', targetId: '1' });
    expect(audit.verifyCheckpoint(checkpoint, key)).toEqual(checkpoint);
    database.close();
  });

  it('rejects a forged checkpoint and a tampered covered audit prefix', () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    audit.record({ action: 'user.created', targetType: 'user', targetId: '1' });
    audit.record({ action: 'user.disabled', targetType: 'user', targetId: '2' });
    const key = randomBytes(32).toString('base64url');
    const checkpoint = audit.createCheckpoint(key);

    expect(() => audit.verifyCheckpoint({ ...checkpoint, eventCount: 99 }, key)).toThrow(
      /authentication/,
    );

    database.exec('DROP TRIGGER audit_events_no_delete');
    database.prepare('DELETE FROM audit_events WHERE id = 1').run();
    expect(() => audit.verifyCheckpoint(checkpoint, key)).toThrow(/does not match/);
    database.close();
  });

  it('allows events appended after an empty checkpoint', () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const key = randomBytes(32).toString('base64url');
    const checkpoint = audit.createCheckpoint(key);
    audit.record({ action: 'system.started', targetType: 'system' });
    expect(audit.verifyCheckpoint(checkpoint, key)).toEqual(checkpoint);
    database.close();
  });
});
