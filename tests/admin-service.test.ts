import { describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin-service.js';
import { AuditService } from '../src/audit/audit-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('administrator service', () => {
  it('protects the final administrator and revokes disabled-user sessions', () => {
    const database = openDatabase(temporaryConfig().database.path);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO users(username, display_name, status, is_admin, created_at) VALUES ('root', 'Root', 'active', 1, ?)`,
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO users(username, display_name, status, is_admin, created_at) VALUES ('member', 'Member', 'active', 0, ?)`,
      )
      .run(now);
    const users = database.prepare('SELECT id, username FROM users ORDER BY id').all() as {
      id: number;
      username: string;
    }[];
    const root = users.find((user) => user.username === 'root');
    const member = users.find((user) => user.username === 'member');
    if (!root || !member) throw new Error('Test users were not created');
    const service = new AdminService(database, new AuditService(database));
    expect(() => {
      service.setAdministrator(root.id, root.id, false);
    }).toThrow(/own administrator/);
    service.setAdministrator(root.id, member.id, true);
    service.setUserStatus(root.id, member.id, 'disabled');
    expect(
      (
        database.prepare('SELECT status FROM users WHERE id = ?').get(member.id) as {
          status: string;
        }
      ).status,
    ).toBe('disabled');
    expect(service.auditEvents()).toHaveLength(2);
    database.close();
  });
});
