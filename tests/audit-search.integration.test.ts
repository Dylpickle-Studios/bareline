import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { TokenService } from '../src/auth/token-service.js';
import { auditFixture } from './audit-fixture.js';

describe('search audit regressions', () => {
  it('retains changes queued during a rebuild, and does not let an expired worker settle a new claim', async () => {
    const f = await auditFixture();
    try {
      let finish!: () => void;
      const spy = vi.spyOn(f.search, 'rebuildRepository').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      f.search.enqueue(f.repository.id);
      const old = f.search.processNext();
      f.search.enqueue(f.repository.id);
      expect(await f.search.processNext()).toBe(false);
      finish();
      await old;
      expect(f.search.status().pending).toBe(1);
      expect(await f.search.processNext()).toBe(true);
      expect(f.search.status().pending).toBe(0);

      let finishOld!: () => void, finishNew!: () => void;
      spy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      spy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
      f.search.enqueue(f.repository.id);
      const expired = f.search.processNext();
      f.database.prepare("UPDATE search_jobs SET lease_until = '2000-01-01T00:00:00.000Z'").run();
      const replacement = f.search.processNext();
      finishOld();
      await expired;
      expect(f.search.status().running).toBe(1);
      finishNew();
      await replacement;
      expect(f.search.status().running).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  it('keeps an accessible match visible behind hundreds of private matches', async () => {
    const f = await auditFixture();
    try {
      const publicRepo = await f.repositories.createForUser({
        actorUserId: f.other.id,
        ownerUserId: f.other.id,
        slug: 'public',
        visibility: 'public',
      });
      const insert = f.database.prepare(
        "INSERT INTO search_documents(resource_type, resource_id, repository_id, title, path, content) VALUES ('repository', ?, ?, ?, '', ?)",
      );
      for (let index = 0; index < 250; index++)
        insert.run(String(index), f.repository.id, 'needle', 'needle');
      insert.run(String(publicRepo.id), publicRepo.id, 'public result', 'needle');
      expect(f.search.search('needle', null)).toEqual([
        expect.objectContaining({ repository: 'public' }),
      ]);
      expect(f.search.search('needle', f.other.id)).toEqual([
        expect.objectContaining({ repository: 'public' }),
      ]);
      f.admin.setGrant(f.repository, f.user.id, 'user', f.other.id, 'read');
      expect(
        f.search.search('needle', f.other.id).some((result) => result.repository === 'audit'),
      ).toBe(true);
      f.config.anonymous.publicRepositories = false;
      expect(f.search.search('needle', null)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('automatically indexes API issue creation and edits', async () => {
    const f = await auditFixture();
    const app = await createApp(f.config);
    try {
      const token = new TokenService(f.database).create({
        userId: f.user.id,
        name: 'issues',
        scopes: ['repository:read', 'repository:write'],
      });
      const headers = { authorization: `Bearer ${token}` };
      const url = '/api/v1/repositories/alice/audit/issues';
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { title: 'uniqueinitial', body: '' },
      });
      expect(response.statusCode).toBe(201);
      expect(f.search.status().pending).toBe(1);
      await f.search.processNext();
      expect(f.search.search('uniqueinitial', f.user.id)).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `${url}/${String(response.json<{ number: number }>().number)}`,
            headers,
            payload: { title: 'uniquelatest' },
          })
        ).statusCode,
      ).toBe(200);
      await f.search.processNext();
      expect(f.search.search('uniqueinitial', f.user.id)).toEqual([]);
      expect(f.search.search('uniquelatest', f.user.id)).toHaveLength(1);
    } finally {
      await app.close();
      await f.cleanup();
    }
  });
});
