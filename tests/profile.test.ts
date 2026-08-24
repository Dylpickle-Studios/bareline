import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('user profile', () => {
  it('updates privacy controls and accepts only bounded raster avatars', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const auth = new AuthService(database, config, new AuditService(database));
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
      email: 'alice@example.test',
    });
    auth.updateProfile(user.id, {
      displayName: 'Alice Example',
      email: 'new@example.test',
      emailPublic: true,
    });
    expect(auth.profile(user.id)).toMatchObject({
      displayName: 'Alice Example',
      email: 'new@example.test',
      emailPublic: true,
      hasAvatar: false,
    });
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(128, 16);
    png.writeUInt32BE(128, 20);
    auth.setAvatar(user.id, png, 'image/png');
    expect(auth.profile(user.id).hasAvatar).toBe(true);
    expect(() => {
      auth.setAvatar(user.id, Buffer.from('<svg></svg>'), 'image/svg+xml');
    }).toThrow(/Avatar/);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(100_000, 20);
    expect(() => {
      auth.setAvatar(user.id, huge, 'image/png');
    }).toThrow(/Avatar/);
    auth.removeAvatar(user.id);
    expect(auth.profile(user.id).hasAvatar).toBe(false);
    database.close();
  });
});
