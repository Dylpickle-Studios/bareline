import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { TokenService } from '../src/auth/token-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

const password = 'correct horse battery staple';
const allScopes = ['repository:read', 'repository:write', 'api:read', 'api:write'];

async function setup() {
  const config = temporaryConfig();
  const database = openDatabase(config.database.path);
  const audit = new AuditService(database);
  const auth = new AuthService(database, config, audit);
  const alice = await auth.register({ username: 'alice', displayName: 'Alice', password });
  const tokens = new TokenService(database, audit);
  const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
  const repositories = new RepositoryService(database, git, config, audit);
  const one = await repositories.createForUser({
    actorUserId: alice.id,
    ownerUserId: alice.id,
    slug: 'one',
    visibility: 'private',
    initializeReadme: true,
  });
  const two = await repositories.createForUser({
    actorUserId: alice.id,
    ownerUserId: alice.id,
    slug: 'two',
    visibility: 'private',
    initializeReadme: true,
  });
  return { config, database, audit, auth, alice, tokens, repositories, one, two };
}

describe('repository-scoped tokens', () => {
  it('records the binding and refuses the administration scope', async () => {
    const { database, alice, tokens, one } = await setup();
    const scoped = tokens.create({
      userId: alice.id,
      name: 'agent',
      scopes: ['repository:read'],
      repositoryId: one.id,
    });
    const unscoped = tokens.create({
      userId: alice.id,
      name: 'personal',
      scopes: ['repository:read'],
    });
    expect(tokens.verify(scoped, 'repository:read')).toEqual({
      userId: alice.id,
      scopes: ['repository:read'],
      repositoryId: one.id,
    });
    expect(tokens.verify(unscoped, 'repository:read')?.repositoryId).toBeNull();
    expect(
      tokens
        .list(alice.id)
        .map((token) => [token.name, token.repository])
        .sort(),
    ).toEqual([
      ['agent', 'alice/one'],
      ['personal', null],
    ]);
    expect(() =>
      tokens.create({
        userId: alice.id,
        name: 'bad',
        scopes: ['api:admin'],
        repositoryId: one.id,
      }),
    ).toThrow(/administration scope/);
    database.close();
  });

  it('reaches only its own repository across the REST API and Git transport', async () => {
    const { config, database, alice, tokens, one } = await setup();
    const scoped = tokens.create({
      userId: alice.id,
      name: 'agent',
      scopes: allScopes,
      repositoryId: one.id,
    });
    const unscoped = tokens.create({ userId: alice.id, name: 'personal', scopes: allScopes });
    database.close();

    const app = await createApp(config);
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const basic = (token: string) => ({
      authorization: `Basic ${Buffer.from(`alice:${token}`).toString('base64')}`,
    });
    try {
      // Its own repository is reachable, for both reads and writes.
      const own = await app.inject({
        method: 'GET',
        url: '/api/v1/repositories/alice/one',
        headers: bearer(scoped),
      });
      expect(own.statusCode).toBe(200);
      const commits = await app.inject({
        method: 'GET',
        url: '/api/v1/repositories/alice/one/commits',
        headers: bearer(scoped),
      });
      expect(commits.statusCode).toBe(200);
      const branch = await app.inject({
        method: 'POST',
        url: '/api/v1/repositories/alice/one/branches',
        headers: { ...bearer(scoped), 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'agent-work', source: 'main' }),
      });
      expect(branch.statusCode).toBe(201);

      // The account's other repository is not, even though the same user owns it.
      const other = await app.inject({
        method: 'GET',
        url: '/api/v1/repositories/alice/two',
        headers: bearer(scoped),
      });
      expect(other.statusCode).toBe(403);
      const otherWrite = await app.inject({
        method: 'POST',
        url: '/api/v1/repositories/alice/two/branches',
        headers: { ...bearer(scoped), 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'sneaky', source: 'main' }),
      });
      expect(otherWrite.statusCode).toBe(403);

      // Neither are the collection, account, or administration endpoints.
      for (const url of [
        '/api/v1/repositories',
        '/api/v1/user/tokens',
        '/api/v1/user/ssh-keys',
        '/api/v1/user/sessions',
        '/api/v1/administration/system',
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: bearer(scoped) });
        expect([url, response.statusCode]).toEqual([url, 403]);
      }
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/repositories',
        headers: { ...bearer(scoped), 'content-type': 'application/json' },
        payload: JSON.stringify({ owner: 'alice', name: 'three', visibility: 'private' }),
      });
      expect(created.statusCode).toBe(403);

      // Git transport honours the same boundary.
      const fetchOwn = await app.inject({
        method: 'GET',
        url: '/alice/one.git/info/refs?service=git-upload-pack',
        headers: basic(scoped),
      });
      expect(fetchOwn.statusCode).toBe(200);
      const fetchOther = await app.inject({
        method: 'GET',
        url: '/alice/two.git/info/refs?service=git-upload-pack',
        headers: basic(scoped),
      });
      expect(fetchOther.statusCode).toBe(401);
      const pushOther = await app.inject({
        method: 'GET',
        url: '/alice/two.git/info/refs?service=git-receive-pack',
        headers: basic(scoped),
      });
      expect(pushOther.statusCode).toBe(401);

      // An ordinary token is unaffected by any of this.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/repositories/alice/two',
            headers: bearer(unscoped),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/repositories',
            headers: bearer(unscoped),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/alice/two.git/info/refs?service=git-upload-pack',
            headers: basic(unscoped),
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('binds a token from the API and the settings form, and reports the binding', async () => {
    const { config, database, alice, tokens } = await setup();
    const personal = tokens.create({ userId: alice.id, name: 'personal', scopes: allScopes });
    const signedIn = new AuthService(database, config, new AuditService(database)).createSession(
      alice.id,
    );
    database.close();

    const app = await createApp(config);
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/user/tokens',
        headers: { authorization: `Bearer ${personal}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'from-api',
          scopes: ['repository:read'],
          repository: 'alice/one',
        }),
      });
      expect(created.statusCode).toBe(201);
      const issued = created.json<{ token: string }>().token;
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/repositories/alice/two',
            headers: { authorization: `Bearer ${issued}` },
          })
        ).statusCode,
      ).toBe(403);

      // An unknown repository, or one the caller cannot read, cannot be bound.
      const unknown = await app.inject({
        method: 'POST',
        url: '/api/v1/user/tokens',
        headers: { authorization: `Bearer ${personal}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'nope',
          scopes: ['repository:read'],
          repository: 'alice/missing',
        }),
      });
      expect(unknown.statusCode).toBe(404);

      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/user/tokens',
        headers: { authorization: `Bearer ${personal}` },
      });
      const items = listed.json<{ items: { name: string; repository: string | null }[] }>().items;
      expect(items.find((item) => item.name === 'from-api')?.repository).toBe('alice/one');
      expect(items.find((item) => item.name === 'personal')?.repository).toBeNull();

      // The credentials page offers the same binding and shows it back.
      const page = await app.inject({
        method: 'GET',
        url: '/settings/credentials',
        headers: { cookie: `session=${signedIn.token}` },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Limit to repository');
      expect(page.body).toContain('limited to alice/one');
      const formCreated = await app.inject({
        method: 'POST',
        url: '/settings/tokens',
        headers: {
          cookie: `session=${signedIn.token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({
          csrf: signedIn.csrfToken,
          name: 'from-form',
          access: 'write',
          expires: '30',
          repository: String(1),
        }).toString(),
      });
      expect(formCreated.statusCode).toBe(200);
      expect(formCreated.body).toContain('Copy this token now');
    } finally {
      await app.close();
    }
  });
});
