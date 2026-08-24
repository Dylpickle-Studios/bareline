import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { TokenService } from '../src/auth/token-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { temporaryConfig } from './helpers.js';

describe('versioned REST API', () => {
  it('shares repository authorization and mutation services and publishes OpenAPI paths', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    await new AuthService(database, config, audit).register({
      username: 'bob',
      displayName: 'Bob',
      password: 'another correct horse password',
    });
    await new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    ).createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'public',
      initializeReadme: true,
    });
    const token = new TokenService(database).create({
      userId: user.id,
      name: 'API',
      scopes: ['api:read', 'api:write', 'api:admin', 'repository:read', 'repository:write'],
    });
    config.security.masterKey = Buffer.alloc(32, 15).toString('base64url');
    await new PluginManager(database, config, audit).installLocal(
      user.id,
      resolve('plugins/example'),
      { trustedRiskAccepted: true },
    );
    database.close();

    const app = await createApp(config);
    try {
      const tree = await app.inject({
        method: 'GET',
        url: '/api/v1/repositories/alice/example/tree',
      });
      expect(tree.statusCode).toBe(200);
      const treeBody = JSON.parse(tree.body) as { items: { name: string; type: string }[] };
      expect(treeBody.items[0]).toMatchObject({ name: 'README.md', type: 'blob' });
      const blame = await app.inject({
        method: 'GET',
        url: '/api/v1/repositories/alice/example/blame/README.md?ref=main',
      });
      expect(blame.statusCode).toBe(200);
      expect(JSON.parse(blame.body) as unknown).toMatchObject({
        path: 'README.md',
        items: [{ lineNumber: 1 }],
      });

      const branch = await app.inject({
        method: 'POST',
        url: '/api/v1/repositories/alice/example/branches',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'api-branch', source: 'main' },
      });
      expect(branch.statusCode).toBe(201);

      const createdRepository = await app.inject({
        method: 'POST',
        url: '/api/v1/repositories',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          owner: 'alice',
          ownerType: 'user',
          name: 'private-api',
          description: 'Created through the API',
          visibility: 'private',
          initializeReadme: true,
        },
      });
      expect(createdRepository.statusCode).toBe(201);
      const anonymousList = await app.inject({ method: 'GET', url: '/api/v1/repositories' });
      const anonymousBody = JSON.parse(anonymousList.body) as { items: { name: string }[] };
      expect(anonymousBody.items.map((item) => item.name)).not.toContain('private-api');
      const privateList = await app.inject({
        method: 'GET',
        url: '/api/v1/repositories',
        headers: { authorization: `Bearer ${token}` },
      });
      const privateBody = JSON.parse(privateList.body) as { items: { name: string }[] };
      expect(privateBody.items.map((item) => item.name)).toContain('private-api');
      const changedRepository = await app.inject({
        method: 'PATCH',
        url: '/api/v1/repositories/alice/private-api',
        headers: { authorization: `Bearer ${token}` },
        payload: { description: 'Updated through the API', visibility: 'public' },
      });
      expect(changedRepository.statusCode).toBe(200);

      const userResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/users/alice',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(JSON.parse(userResponse.body) as unknown).toMatchObject({
        username: 'alice',
        displayName: 'Alice',
      });
      const changedProfile = await app.inject({
        method: 'PATCH',
        url: '/api/v1/user/profile',
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Alice API', emailPublic: false },
      });
      expect(changedProfile.statusCode).toBe(200);
      expect(JSON.parse(changedProfile.body) as unknown).toMatchObject({
        displayName: 'Alice API',
        emailPublic: false,
      });
      const appearance = await app.inject({
        method: 'PUT',
        url: '/api/v1/user/appearance',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          theme: 'dark',
          accent: 'green',
          uiFont: 'humanist',
          codeFont: 'mono',
          reducedMotion: true,
          pluginTheme: null,
        },
      });
      expect(appearance.statusCode).toBe(200);
      expect(JSON.parse(appearance.body) as unknown).toMatchObject({
        theme: 'dark',
        reducedMotion: true,
      });
      const sessionList = await app.inject({
        method: 'GET',
        url: '/api/v1/user/sessions',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(sessionList.statusCode).toBe(200);

      const createdToken = await app.inject({
        method: 'POST',
        url: '/api/v1/user/tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Automation',
          scopes: ['repository:read'],
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      });
      expect(createdToken.statusCode).toBe(201);
      const rawCreatedToken = (JSON.parse(createdToken.body) as { token: string }).token;
      expect(rawCreatedToken).toMatch(/^ghp_/);
      const listedTokens = await app.inject({
        method: 'GET',
        url: '/api/v1/user/tokens',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listedTokens.statusCode).toBe(200);
      expect(listedTokens.body).not.toContain(rawCreatedToken);
      const automation = (
        JSON.parse(listedTokens.body) as { items: { id: number; name: string }[] }
      ).items.find((item) => item.name === 'Automation');
      expect(automation).toBeDefined();
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/user/tokens/${String(automation?.id)}`,
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(204);

      const createdGroup = await app.inject({
        method: 'POST',
        url: '/api/v1/groups',
        headers: { authorization: `Bearer ${token}` },
        payload: { slug: 'acme', displayName: 'Acme' },
      });
      expect(createdGroup.statusCode).toBe(201);
      const member = await app.inject({
        method: 'PUT',
        url: '/api/v1/groups/acme/members',
        headers: { authorization: `Bearer ${token}` },
        payload: { username: 'bob', role: 'manager' },
      });
      expect(member.statusCode).toBe(200);
      const group = await app.inject({
        method: 'GET',
        url: '/api/v1/groups/acme',
        headers: { authorization: `Bearer ${token}` },
      });
      const groupBody = JSON.parse(group.body) as {
        members: { username: string; role: string }[];
      };
      expect(groupBody.members).toContainEqual(
        expect.objectContaining({ username: 'bob', role: 'manager' }),
      );
      const transferred = await app.inject({
        method: 'PATCH',
        url: '/api/v1/repositories/alice/private-api',
        headers: { authorization: `Bearer ${token}` },
        payload: { owner: 'acme', ownerType: 'group' },
      });
      expect(transferred.statusCode).toBe(200);
      expect(JSON.parse(transferred.body) as unknown).toMatchObject({
        owner: 'acme',
        ownerType: 'group',
      });

      const administration = await app.inject({
        method: 'GET',
        url: '/api/v1/administration/system',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(administration.statusCode).toBe(200);
      expect(JSON.parse(administration.body) as unknown).toMatchObject({
        counts: { users: 2 },
        git: { executable: 'git' },
      });

      const pluginList = await app.inject({
        method: 'GET',
        url: '/api/v1/administration/plugins',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(pluginList.statusCode).toBe(200);
      expect(JSON.parse(pluginList.body) as unknown).toMatchObject({
        items: [{ id: 'example.word-count', enabled: false }],
      });
      const pluginPermission = await app.inject({
        method: 'PUT',
        url: '/api/v1/administration/plugins/example.word-count/permissions/ui.global',
        headers: { authorization: `Bearer ${token}` },
        payload: { granted: true },
      });
      expect(pluginPermission.statusCode).toBe(200);
      const createdInvite = await app.inject({
        method: 'POST',
        url: '/api/v1/administration/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: { expiresInDays: 3 },
      });
      expect(createdInvite.statusCode).toBe(201);
      expect((JSON.parse(createdInvite.body) as { token: string }).token.length).toBeGreaterThan(
        32,
      );
      const inviteList = await app.inject({
        method: 'GET',
        url: '/api/v1/administration/invites',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(JSON.parse(inviteList.body) as unknown).toMatchObject({ items: [{ usedAt: null }] });
      const searchStatus = await app.inject({
        method: 'GET',
        url: '/api/v1/administration/search',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(searchStatus.statusCode).toBe(200);
      expect(JSON.parse(searchStatus.body) as unknown).toMatchObject({ documents: 0 });
      const runtimeSettings = await app.inject({
        method: 'GET',
        url: '/api/v1/administration/settings',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(runtimeSettings.statusCode).toBe(200);
      expect(JSON.parse(runtimeSettings.body) as unknown).toMatchObject({
        registrationMode: 'open',
        anonymousPublicRepositories: true,
      });

      const specification = app.swagger() as {
        paths: Record<
          string,
          Record<
            string,
            {
              tags?: string[];
              parameters?: { name: string; in: string }[];
              requestBody?: unknown;
              responses?: Record<
                string,
                { content?: Record<string, { schema?: Record<string, unknown> }> }
              >;
            }
          >
        >;
      };
      expect(specification.paths).toHaveProperty('/api/v1/repositories/{owner}/{repository}/tree');
      expect(specification.paths).toHaveProperty('/api/v1/repositories');
      expect(specification.paths).toHaveProperty(
        '/api/v1/repositories/{owner}/{repository}/branches',
      );
      expect(specification.paths).toHaveProperty('/api/v1/groups/{group}/members');
      for (const path of [
        '/api/v1/repositories',
        '/api/v1/search',
        '/api/v1/repositories/{owner}/{repository}',
        '/api/v1/repositories/{owner}/{repository}/collaborators',
        '/api/v1/repositories/{owner}/{repository}/tree',
        '/api/v1/repositories/{owner}/{repository}/blob/{*}',
        '/api/v1/repositories/{owner}/{repository}/blame/{*}',
        '/api/v1/repositories/{owner}/{repository}/commits',
        '/api/v1/repositories/{owner}/{repository}/commits/{objectId}',
        '/api/v1/repositories/{owner}/{repository}/compare',
        '/api/v1/repositories/{owner}/{repository}/branches',
        '/api/v1/repositories/{owner}/{repository}/tags',
        '/api/v1/repositories/{owner}/{repository}/files/{*}',
        '/api/v1/users/{username}',
        '/api/v1/user/tokens',
        '/api/v1/user/tokens/{tokenId}',
        '/api/v1/user/profile',
        '/api/v1/user/appearance',
        '/api/v1/user/sessions',
        '/api/v1/user/ssh-keys',
        '/api/v1/user/ssh-keys/{keyId}',
        '/api/v1/groups',
        '/api/v1/groups/{group}',
        '/api/v1/groups/{group}/members',
        '/api/v1/administration/system',
        '/api/v1/administration/users',
        '/api/v1/administration/users/{userId}',
        '/api/v1/administration/repositories',
        '/api/v1/administration/audit-events',
        '/api/v1/administration/plugins',
        '/api/v1/administration/plugins/{pluginId}',
        '/api/v1/administration/plugins/{pluginId}/permissions/{capability}',
        '/api/v1/administration/invites',
        '/api/v1/administration/invites/{inviteId}',
        '/api/v1/administration/search',
        '/api/v1/administration/search/rebuild',
        '/api/v1/administration/settings',
        '/api/v1/plugins/{pluginId}/{endpointId}',
      ])
        expect(specification.paths).toHaveProperty(path);

      for (const [path, pathItem] of Object.entries(specification.paths)) {
        if (!path.startsWith('/api/v1/')) continue;
        for (const [method, operation] of Object.entries(pathItem)) {
          if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
          expect(operation.tags, `${method.toUpperCase()} ${path} tags`).not.toHaveLength(0);
          expect(
            Object.keys(operation.responses ?? {}),
            `${method.toUpperCase()} ${path} responses`,
          ).not.toHaveLength(0);
          for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]))
            expect(
              operation.parameters,
              `${method.toUpperCase()} ${path} parameter ${name ?? ''}`,
            ).toEqual(expect.arrayContaining([expect.objectContaining({ in: 'path', name })]));
          if (!path.startsWith('/api/v1/plugins/')) {
            for (const [status, response] of Object.entries(operation.responses ?? {})) {
              if (!status.startsWith('2') || status === '204') continue;
              const schema = response.content?.['application/json']?.schema;
              expect(schema, `${method.toUpperCase()} ${path} ${status} JSON schema`).toBeDefined();
              expect(
                JSON.stringify(schema),
                `${method.toUpperCase()} ${path} exact response`,
              ).not.toContain('"additionalProperties":true');
            }
            const requestBody = operation.requestBody as
              | {
                  content?: Record<string, { schema?: Record<string, unknown> }>;
                }
              | undefined;
            const bodySchema = requestBody?.content?.['application/json']?.schema;
            if (bodySchema)
              expect(
                JSON.stringify(bodySchema),
                `${method.toUpperCase()} ${path} exact request`,
              ).not.toContain('"additionalProperties":true');
          }
        }
      }
    } finally {
      await app.close();
    }
  });
});
