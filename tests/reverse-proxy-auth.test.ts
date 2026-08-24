import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('reverse proxy authentication', () => {
  it('normalizes provisioned identities and refuses disabled accounts', () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const auth = new AuthService(database, config, new AuditService(database));
    const user = auth.loginReverseProxy('Alice', 'Alice Example', true, 'request', '127.0.0.1');
    expect(user.username).toBe('alice');
    database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    expect(() => auth.loginReverseProxy('alice', undefined, false)).toThrow();
    database.close();
  });

  it('does not silently provision when auto-create is disabled', () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const auth = new AuthService(database, config, new AuditService(database));
    expect(() => auth.loginReverseProxy('unknown', undefined, false)).toThrow();
    database.close();
  });
});
